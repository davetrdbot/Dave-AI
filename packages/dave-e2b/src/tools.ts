import type { DaveDatabase } from "@dave/db";
import { addE2BKey, listE2BKeys, removeE2BKey, checkE2BKeyHealth, createSandboxWithKeyFailover } from "./e2b-keys.js";

/**
 * Update 12: E2B as real agent tools -- disposable compute Dave or a
 * worker can spin up for an isolated task (e.g. R_Feed backtest
 * analysis) WITHOUT touching the main DSH/OpenSandbox chosen in Step
 * 1.3. `run_code_in_e2b` is deliberately NOT here -- see e2b-client.ts's
 * own comment: actual code execution is E2B's gRPC data plane, not a
 * REST call this build implements.
 */
export interface E2BToolContext {
  userId: string;
  db: DaveDatabase;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: E2BToolContext) => Promise<unknown>;
}

export const E2B_TOOLS: ToolDefinition[] = [
  {
    name: "add_e2b_key",
    description: "Store a real E2B API key (up to 10).",
    parameters: { type: "object", properties: { label: { type: "string" }, apiKey: { type: "string" } }, required: ["label", "apiKey"] },
    execute: async (args, ctx) => addE2BKey(ctx.db, ctx.userId, args.label as string, args.apiKey as string),
  },
  {
    name: "list_e2b_keys",
    description: "List stored E2B keys and their real health status.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => listE2BKeys(ctx.db, ctx.userId),
  },
  {
    name: "remove_e2b_key",
    description: "Delete a stored E2B key.",
    parameters: { type: "object", properties: { keyId: { type: "string" } }, required: ["keyId"] },
    execute: async (args, ctx) => ({ removed: removeE2BKey(ctx.db, ctx.userId, args.keyId as string) }),
  },
  {
    name: "check_e2b_key_health",
    description: "Run a real health check against one stored E2B key right now.",
    parameters: { type: "object", properties: { keyId: { type: "string" } }, required: ["keyId"] },
    execute: async (args, ctx) => {
      const key = listE2BKeys(ctx.db, ctx.userId).find((k) => k.id === args.keyId);
      if (!key) throw new Error(`no stored E2B key "${args.keyId}"`);
      return { healthy: await checkE2BKeyHealth(ctx.db, ctx.userId, key) };
    },
  },
  {
    name: "create_e2b_sandbox",
    description: "Spin up a disposable E2B sandbox for an isolated task (e.g. R_Feed backtest analysis) -- separate from the main sandbox, auto-fails over across stored keys.",
    parameters: {
      type: "object",
      properties: { templateID: { type: "string" }, timeoutSeconds: { type: "number" }, metadata: { type: "object" } },
    },
    execute: async (args, ctx) => createSandboxWithKeyFailover(ctx.db, ctx.userId, { templateID: args.templateID as string | undefined, timeoutSeconds: args.timeoutSeconds as number | undefined, metadata: args.metadata as Record<string, string> | undefined }),
  },
];
