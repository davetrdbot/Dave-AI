import { readLive } from "@dave/memory";
import { runSelfTest } from "./selftest.js";
import { getPairingStatus } from "./pairing.js";
import { BootstrapFlow, type Transport } from "./bootstrap.js";

/**
 * Part 3 (B5): goal-config/selftest/onboarding exposed as real,
 * agent-callable tools instead of passive systems only a command
 * handler could reach.
 */
export interface CoreToolContext {
  userId: string;
  workspaceRoot: string;
}

export interface CoreToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: CoreToolContext) => Promise<unknown>;
}

const noopTransport: Transport = { send: () => {} };

export const CORE_TOOLS: CoreToolDefinition[] = [
  {
    name: "get_goal_config",
    description: "Read the user's real goal.yaml -- their stated trading goals/targets, as they set them, verbatim.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => ({ goal: readLive(ctx.userId, "goal.yaml") }),
  },
  {
    name: "run_selftest",
    description: "Run a real diagnostic pass -- EA connection, memory files present, sandbox health, pairing status. Use this if something feels off before blaming the user's setup.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => runSelfTest(ctx.userId, ctx.workspaceRoot),
  },
  {
    name: "get_onboarding_status",
    description: "Get the user's real bootstrap/onboarding progress (name/style captured, rules-file ack, or already complete).",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => new BootstrapFlow(noopTransport).getProgress(ctx.userId),
  },
  {
    name: "get_pairing_status",
    description: "Check whether this user is genuinely paired yet.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => ({ status: getPairingStatus(ctx.userId) }),
  },
];
