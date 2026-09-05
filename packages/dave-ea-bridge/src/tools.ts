import { getLastKnownState, getLastKnownAccountSnapshot } from "./ea-webhook.js";

/**
 * Part 1 item 10 (bot-side half): "the agent should NOT have to wait for
 * the periodic push if it needs current state right now." Honest about
 * what's actually possible -- MT5's WebRequest is one-directional, so
 * there is no way to force the EA to push early. What these genuinely
 * do is read the most recently RECEIVED report/snapshot back instantly,
 * bypassing the wait for dave-ea-bridge's own next scheduled read --
 * not a live round-trip to MT5.
 */
export interface EaToolContext {
  userId: string;
}

export interface EaToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: EaToolContext) => Promise<unknown>;
}

export const EA_STATE_TOOLS: EaToolDefinition[] = [
  {
    name: "get_live_state",
    description:
      "Get the current tick/positions/pending-orders state right now, without waiting for the periodic push interval. " +
      "Reflects the EA's most recently received report (real, but eventually-consistent -- not a live MT5 query, since " +
      "WebRequest is one-directional and Dave cannot force the EA to report early).",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => getLastKnownState(ctx.userId),
  },
  {
    name: "get_account_balance",
    description: "Get the account balance/equity/margin right now, standalone -- doesn't require pulling full state just to see the balance.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => {
      const snapshot = getLastKnownAccountSnapshot(ctx.userId);
      if (!snapshot) return { balance: undefined, note: "no EA report received yet for this user" };
      return { balance: snapshot.balance, equity: snapshot.equity, margin: snapshot.margin, freeMargin: snapshot.freeMargin, updatedAt: snapshot.updatedAt };
    },
  },
];
