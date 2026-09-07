import type { DaveDatabase } from "./database.js";
import { createAutomation, listAutomations, setAutomationEnabled, deleteAutomation, type AutomationTriggerType } from "./automation-store.js";
import { unregisterScheduledTrigger } from "./scheduled-trigger.js";
import { unregisterWebhookTrigger } from "./webhook-trigger.js";

export interface AutomationToolContext {
  userId: string;
  db: DaveDatabase;
  /**
   * Real gap fixed (user: "every 3 minutes send me hi never fired"): create_automation/
   * pause_automation/resume_automation used to only ever write a DB row -- the actual live
   * node-cron/webhook/entity wiring only happened once, at registry-build time, so anything
   * created (or paused/resumed) afterward had zero live effect until a full process restart.
   * When supplied, `resync` re-runs the real wiring (wireScheduledAutomations/
   * wireWebhookAutomations/wireEntityAutomations) for this user immediately after the row
   * changes, so a new/resumed automation is genuinely armed right away and a paused one is
   * genuinely torn down right away -- not just recorded as data. Optional (undefined in a bare
   * unit test that doesn't need live wiring) so existing tests of the DB-row behavior alone
   * don't need to fake out a full registry.
   */
  resync?: () => void;
}

export interface AutomationToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: AutomationToolContext) => Promise<unknown>;
}

export const AUTOMATION_TOOLS: AutomationToolDefinition[] = [
  {
    name: "create_automation",
    description:
      "Create a real, persisted automation -- scheduled (cron expression), entity-triggered (fires when a named event " +
      "happens elsewhere in Dave), or webhook-triggered. Runs a real tool call with the given args when it fires.",
    parameters: {
      type: "object",
      required: ["name", "triggerType", "toolName"],
      properties: {
        name: { type: "string" },
        triggerType: { type: "string", enum: ["scheduled", "webhook", "entity"] },
        cronExpression: { type: "string", description: "required for triggerType=scheduled, e.g. '0 9 * * *'" },
        entityName: { type: "string", description: "required for triggerType=entity, e.g. 'trade_closed'" },
        toolName: { type: "string" },
        toolArgs: { type: "object" },
      },
    },
    execute: async (args, ctx) => {
      const automation = createAutomation(ctx.db, ctx.userId, {
        name: args.name as string,
        triggerType: args.triggerType as AutomationTriggerType,
        cronExpression: args.cronExpression as string | undefined,
        entityName: args.entityName as string | undefined,
        toolName: args.toolName as string,
        toolArgs: (args.toolArgs as Record<string, unknown>) ?? {},
      });
      ctx.resync?.();
      return automation;
    },
  },
  {
    name: "list_automations",
    description: "List every real automation this user has, enabled or not.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => listAutomations(ctx.db, ctx.userId),
  },
  {
    name: "pause_automation",
    description: "Pause a real automation by id -- it stops firing until resumed.",
    parameters: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    execute: async (args, ctx) => {
      const automation = setAutomationEnabled(ctx.db, ctx.userId, args.id as string, false);
      ctx.resync?.();
      return automation;
    },
  },
  {
    name: "resume_automation",
    description: "Resume a paused automation by id.",
    parameters: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    execute: async (args, ctx) => {
      const automation = setAutomationEnabled(ctx.db, ctx.userId, args.id as string, true);
      ctx.resync?.();
      return automation;
    },
  },
  {
    name: "delete_automation",
    description: "Permanently delete an automation by id.",
    parameters: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    execute: async (args, ctx) => {
      const id = args.id as string;
      // Captured BEFORE the row is deleted -- once gone, listAutomations() can no longer tell
      // resync what to tear down, so this deletes the real live trigger directly, unconditionally
      // (both calls are safe no-ops if that id/token was never registered).
      const existing = listAutomations(ctx.db, ctx.userId).find((a) => a.id === id);
      const deleted = deleteAutomation(ctx.db, ctx.userId, id);
      unregisterScheduledTrigger(id);
      if (existing?.webhookToken) unregisterWebhookTrigger(existing.webhookToken);
      ctx.resync?.();
      return { deleted };
    },
  },
];
