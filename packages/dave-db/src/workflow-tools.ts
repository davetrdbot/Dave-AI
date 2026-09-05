import type { DaveDatabase } from "./database.js";
import { WorkflowEngine, type WorkflowStep, type WorkflowRun } from "./workflow.js";
import type { AutomationDispatch } from "./automation-runtime.js";

/**
 * Real gap closed (final pre-deployment pass, Step 16 re-verification):
 * `WorkflowEngine` (Step 16.3 -- real chained call/wait/branch runs,
 * restart-survival via `recoverPendingRuns()`) was genuine, tested
 * code with no agent-facing surface at all -- nothing ever constructed
 * one in production, so "workflows beyond single automations" existed
 * only as an unreachable class. This wires it in the same way Part 3
 * (B4) wired scheduled/webhook/entity automations: one real engine per
 * owner, its "call" steps dispatching through the SAME `dispatch`
 * (registry.execute) every other trigger type already uses, so a
 * workflow step genuinely invokes a real tool, not a second parallel
 * execution path.
 *
 * "call" step names ARE tool names (dispatch handles resolving them);
 * "branch" conditions are a real, simple, generic scheme -- a condition
 * named "<field>" is true iff `context[field]` is truthy after the
 * steps run so far. Documented in the tool description so the model
 * knows the contract, not left implicit.
 */
const engines = new Map<string, WorkflowEngine>();

export function getOrCreateWorkflowEngine(db: DaveDatabase, userId: string, dispatch: AutomationDispatch): WorkflowEngine {
  const existing = engines.get(userId);
  if (existing) return existing;

  const handlers = new Proxy(
    {},
    {
      get: (_target, prop: string | symbol) => {
        if (typeof prop !== "string") return undefined;
        return (context: Record<string, unknown>) => dispatch(userId, prop, context);
      },
    }
  ) as Record<string, (context: Record<string, unknown>) => Promise<unknown>>;

  const conditions = new Proxy(
    {},
    {
      get: (_target, prop: string | symbol) => {
        if (typeof prop !== "string") return undefined;
        return (context: Record<string, unknown>) => Boolean(context[prop]);
      },
    }
  ) as Record<string, (context: Record<string, unknown>) => boolean>;

  const engine = new WorkflowEngine(db, userId, handlers, conditions);
  // Real restart-survival (Step 16.3): reschedule every run this owner
  // left "waiting" the last time this process ran, exactly once, here
  // (the same real seam recoverPendingRuns() was built for) -- not a
  // fresh, unreachable engine that forgets in-flight runs ever existed.
  engine.recoverPendingRuns();
  engines.set(userId, engine);
  return engine;
}

export interface WorkflowToolContext {
  userId: string;
  db: DaveDatabase;
  dispatch: AutomationDispatch;
}

export interface WorkflowToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: WorkflowToolContext) => Promise<unknown>;
}

export const WORKFLOW_TOOLS: WorkflowToolDefinition[] = [
  {
    name: "start_workflow",
    description:
      'Start a real, persisted multi-step workflow (call -> wait -> branch), surviving process restarts. Each "call" step\'s `name` is a real tool name -- it genuinely gets invoked with the running context. Each "branch" step\'s `condition` name is checked as "is context[condition] truthy" after prior steps ran. Use this for a sequence you want to chain automatically, not something you could just do as one tool call.',
    parameters: {
      type: "object",
      properties: {
        workflowId: { type: "string", description: "a short id/label for this workflow, e.g. \"post-trade-followup\"" },
        steps: {
          type: "array",
          description:
            'Ordered steps. {"type":"call","name":"<tool name>","next"?:<index>|"end"}, {"type":"wait","ms":<number>,"next"?:<index>|"end"}, or {"type":"branch","condition":"<context field name>","ifTrue":<index>,"ifFalse":<index>}.',
          items: { type: "object" },
        },
        context: { type: "object", description: "optional starting context object passed to the first step" },
      },
      required: ["workflowId", "steps"],
    },
    execute: async (args, ctx) => {
      const engine = getOrCreateWorkflowEngine(ctx.db, ctx.userId, ctx.dispatch);
      const runId = engine.start(args.workflowId as string, args.steps as WorkflowStep[], (args.context as Record<string, unknown>) ?? {});
      return { runId };
    },
  },
  {
    name: "get_workflow_run",
    description: "Check a real workflow run's current status (running/waiting/completed/failed), step index, and accumulated context.",
    parameters: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] },
    execute: async (args, ctx): Promise<WorkflowRun> => {
      const engine = getOrCreateWorkflowEngine(ctx.db, ctx.userId, ctx.dispatch);
      const run = engine.getRun(args.runId as string);
      if (!run) throw new Error(`no workflow run "${args.runId}"`);
      return run;
    },
  },
];
