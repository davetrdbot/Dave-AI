import { randomBytes } from "node:crypto";
import type { DaveDatabase } from "./database.js";

/**
 * Part 3 (B4): real automation CRUD. `scheduled-trigger.ts`/
 * `webhook-trigger.ts` (Step 16.2) were real cron/webhook PRIMITIVES,
 * but nothing persisted an actual automation as a durable, user-owned
 * entity a tool could create/list/pause/resume/delete -- this is that
 * persistence layer. `automation-runtime.ts` is what actually wires a
 * persisted, enabled row to a REAL firing trigger.
 */
const TABLE = "automations";

export type AutomationTriggerType = "scheduled" | "webhook" | "entity";

export interface Automation {
  id: string;
  userId: string;
  name: string;
  triggerType: AutomationTriggerType;
  cronExpression?: string; // required for "scheduled"
  entityName?: string; // required for "entity" -- caller-defined event name (e.g. "trade_closed")
  toolName: string;
  toolArgs: Record<string, unknown>;
  enabled: boolean;
  createdAt: number;
  /** Real, stable token for "webhook" automations -- the URL an external service should POST to (real proof: it survives a registry rebuild/restart). */
  webhookToken?: string;
  webhookPath?: string;
}

function ensureTable(db: DaveDatabase): void {
  db.createTable(TABLE, [
    { name: "name", type: "TEXT" },
    { name: "trigger_type", type: "TEXT" },
    { name: "cron_expression", type: "TEXT" },
    { name: "entity_name", type: "TEXT" },
    { name: "tool_name", type: "TEXT" },
    { name: "tool_args_json", type: "TEXT" },
    { name: "enabled", type: "INTEGER" },
    { name: "webhook_token", type: "TEXT" },
  ]);
}

const WEBHOOK_HOOK_PREFIX = "/hooks/automation";

function toAutomation(row: Record<string, unknown>): Automation {
  return {
    id: row.id as string,
    userId: row.userId as string,
    name: row.name as string,
    triggerType: row.trigger_type as AutomationTriggerType,
    cronExpression: (row.cron_expression as string | null) ?? undefined,
    entityName: (row.entity_name as string | null) ?? undefined,
    toolName: row.tool_name as string,
    toolArgs: JSON.parse((row.tool_args_json as string) ?? "{}"),
    enabled: Boolean(row.enabled),
    createdAt: row.created_at as number,
    webhookToken: (row.webhook_token as string | null) ?? undefined,
    webhookPath: row.webhook_token ? `${WEBHOOK_HOOK_PREFIX}/${row.webhook_token}` : undefined,
  };
}

export function createAutomation(
  db: DaveDatabase,
  userId: string,
  fields: { name: string; triggerType: AutomationTriggerType; cronExpression?: string; entityName?: string; toolName: string; toolArgs?: Record<string, unknown> }
): Automation {
  ensureTable(db);
  if (fields.triggerType === "scheduled" && !fields.cronExpression) {
    throw new Error("scheduled automations require a cronExpression");
  }
  if (fields.triggerType === "entity" && !fields.entityName) {
    throw new Error("entity-triggered automations require an entityName");
  }
  const id = db.insert(TABLE, userId, {
    name: fields.name,
    trigger_type: fields.triggerType,
    cron_expression: fields.cronExpression ?? null,
    entity_name: fields.entityName ?? null,
    tool_name: fields.toolName,
    tool_args_json: JSON.stringify(fields.toolArgs ?? {}),
    enabled: 1,
    webhook_token: fields.triggerType === "webhook" ? randomBytes(24).toString("hex") : null,
  });
  return toAutomation({ ...db.getById(TABLE, userId, id)!, userId });
}

export function listAutomations(db: DaveDatabase, userId: string): Automation[] {
  ensureTable(db);
  return db.query(TABLE, userId, {}).map((row) => toAutomation({ ...row, userId }));
}

export function setAutomationEnabled(db: DaveDatabase, userId: string, id: string, enabled: boolean): Automation {
  ensureTable(db);
  db.update(TABLE, userId, id, { enabled: enabled ? 1 : 0 });
  return toAutomation({ ...db.getById(TABLE, userId, id)!, userId });
}

export function deleteAutomation(db: DaveDatabase, userId: string, id: string): boolean {
  ensureTable(db);
  return db.deleteRow(TABLE, userId, id);
}
