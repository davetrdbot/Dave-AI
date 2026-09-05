import { loadFrozenSnapshot } from "./hermes-store.js";
import { searchSessions } from "./session-search.js";
import { getAtoms, getScenarios } from "./tencent-tiers.js";
import { markRecalled } from "./recall-guard.js";

/**
 * Update 14 (mid-session gap: "recall tool and others"): recall was a
 * real, enforced GATE (Step 4.5's `executeTask`/`markRecalled`) but
 * nothing actually did the real recall work and satisfied that gate as
 * a callable agent tool -- Dave had no tool it could call to actually
 * pull its own memory before acting. This is that tool: a genuine
 * composite pull across every real memory tier (frozen snapshot,
 * session search, L1 atoms, L2 scenarios), and it marks the calling
 * task's recall satisfied as a real side effect, not a separate step.
 */
export interface MemoryToolContext {
  actorId: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: MemoryToolContext) => Promise<unknown>;
}

export const MEMORY_TOOLS: ToolDefinition[] = [
  {
    name: "recall_memory",
    description: "Pull your real memory before acting on a non-trivial task -- frozen snapshot, session search (if a query is given), recent atoms, and scenarios. Satisfies the recall-before-acting requirement for taskId.",
    parameters: {
      type: "object",
      properties: { taskId: { type: "string" }, query: { type: "string", description: "Optional -- search past sessions for this." } },
      required: ["taskId"],
    },
    execute: async (args, ctx) => {
      const snapshot = loadFrozenSnapshot(ctx.actorId);
      const sessionHits = args.query ? searchSessions(ctx.actorId, args.query as string) : [];
      const atoms = getAtoms(ctx.actorId);
      const scenarios = getScenarios(ctx.actorId);
      const summary = `frozen snapshot + ${sessionHits.length} session hit(s) + ${atoms.length} atom(s) + ${scenarios.length} scenario(s)`;
      markRecalled(ctx.actorId, args.taskId as string, summary);
      return { snapshot, sessionHits, atoms, scenarios, summary };
    },
  },
];
