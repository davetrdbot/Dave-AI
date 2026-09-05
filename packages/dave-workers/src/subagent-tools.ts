import { createWorker, listWorkers, getWorker, retireWorker, type WorkerAssignment, type WorkerRole } from "./worker-factory.js";

/**
 * Update 14 (mid-session gap the user flagged: "we haven't build the
 * subagents tool too"): workers ARE Dave's subagents (Step 12), but
 * `createWorker`/`listWorkers`/`retireWorker` were only ever plain
 * functions -- nothing exposed them as real agent-callable tools. Dave
 * could not actually spin up or retire a worker through a tool call
 * until now.
 */
export interface SubagentToolContext {
  ownerUserId: string;
}

export interface SubagentToolDefinitionShape {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: SubagentToolContext) => Promise<unknown>;
}

export const SUBAGENT_TOOLS: SubagentToolDefinitionShape[] = [
  {
    name: "create_subagent",
    description: "Spin up a real subagent (worker) for a task -- named like a person, not 'Worker-1'. Fixed assignment stays active until retired; temporary closes itself out.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Optional -- omit to have one drawn from the real name pool." },
        assignment: { type: "string", enum: ["fixed", "temporary"] },
        role: { type: "string", enum: ["generic", "journal", "trading"], description: "Defaults to generic. 'trading' is the only role that gets real trade-placing tools." },
        task: { type: "string" },
      },
      required: ["assignment", "task"],
    },
    execute: async (args, ctx) =>
      createWorker(ctx.ownerUserId, {
        name: args.name as string | undefined,
        assignment: args.assignment as WorkerAssignment,
        role: args.role as WorkerRole | undefined,
        task: args.task as string,
      }),
  },
  {
    name: "list_subagents",
    description: "List your active subagents (or all, including retired ones).",
    parameters: { type: "object", properties: { includeRetired: { type: "boolean" } } },
    execute: async (args, ctx) => listWorkers(ctx.ownerUserId, !args.includeRetired),
  },
  {
    name: "get_subagent",
    description: "Get one subagent's real current state by id.",
    parameters: { type: "object", properties: { workerId: { type: "string" } }, required: ["workerId"] },
    execute: async (args, ctx) => {
      const worker = getWorker(ctx.ownerUserId, args.workerId as string);
      if (!worker) throw new Error(`No subagent "${args.workerId}".`);
      return worker;
    },
  },
  {
    name: "retire_subagent",
    description: "Retire a subagent -- its assignment closes out, it stops appearing in the active list.",
    parameters: { type: "object", properties: { workerId: { type: "string" } }, required: ["workerId"] },
    execute: async (args, ctx) => {
      retireWorker(ctx.ownerUserId, args.workerId as string);
      return { ok: true };
    },
  },
];
