import type { DaveDatabase } from "./database.js";
import { createAutomation, listAutomations, setAutomationEnabled, deleteAutomation, type AutomationTriggerType } from "./automation-store.js";

export interface AutomationToolContext {
  userId: string;
  db: DaveDatabase;
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
    execute: async (args, ctx) =>
      createAutomation(ctx.db, ctx.userId, {
        name: args.name as string,
        triggerType: args.triggerType as AutomationTriggerType,
        cronExpression: args.cronExpression as string | undefined,
        entityName: args.entityName as string | undefined,
        toolName: args.toolName as string,
        toolArgs: (args.toolArgs as Record<string, unknown>) ?? {},
      }),
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
    execute: async (args, ctx) => setAutomationEnabled(ctx.db, ctx.userId, args.id as string, false),
  },
  {
    name: "resume_automation",
    description: "Resume a paused automation by id.",
    parameters: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    execute: async (args, ctx) => setAutomationEnabled(ctx.db, ctx.userId, args.id as string, true),
  },
  {
    name: "delete_automation",
    description: "Permanently delete an automation by id.",
    parameters: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    execute: async (args, ctx) => ({ deleted: deleteAutomation(ctx.db, ctx.userId, args.id as string) }),
  },
];
