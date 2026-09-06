import { getLastKnownState, getLastKnownAccountSnapshot } from "./ea-webhook.js";
import { requestAnalysis } from "./analysis-request.js";

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

/**
 * Item 5 (DAVEMA retirement): real, on-demand market analysis computed LIVE by the connected
 * MT5 EA itself -- no external API call. Each of these is a SEPARATE, on-demand tool (not
 * automatically included in every message) so calling Dave never pays for analysis it doesn't
 * ask for; the EA's existing heartbeat/account-push cadence is completely unchanged. This is
 * the first real batch (trend/momentum/volatility) ported from the actual reference EA's own
 * computation logic (see ea/DaveEA.mq5's Ep_Trend/Ep_Momentum/Ep_Volatility) -- the remaining
 * DAVEMA endpoints follow the exact same request/response pattern and are tracked as further
 * work, not yet ported.
 */
export const EA_ANALYSIS_TOOLS: EaToolDefinition[] = [
  {
    name: "get_trend",
    description:
      "Real, on-demand trend analysis (moving averages, EMA alignment, golden/death cross, bias score) computed LIVE by the connected MT5 EA for ANY symbol in its Market Watch, not just the chart it's attached to. Replaces the retired DAVEMA /trend endpoint.",
    parameters: { type: "object", properties: { symbol: { type: "string" }, timeframe: { type: "string" } }, required: ["symbol"] },
    execute: async (args, ctx) => requestAnalysis(ctx.userId, "trend", args.symbol as string, (args.timeframe as string) ?? "M15"),
  },
  {
    name: "get_momentum",
    description:
      "Real, on-demand momentum analysis (RSI/MACD/Stochastic/CCI/Williams %R, overall bull/bear signal) computed LIVE by the connected MT5 EA for ANY symbol in its Market Watch. Replaces the retired DAVEMA /momentum endpoint.",
    parameters: { type: "object", properties: { symbol: { type: "string" }, timeframe: { type: "string" } }, required: ["symbol"] },
    execute: async (args, ctx) => requestAnalysis(ctx.userId, "momentum", args.symbol as string, (args.timeframe as string) ?? "M15"),
  },
  {
    name: "get_volatility",
    description:
      "Real, on-demand volatility analysis (ATR, Bollinger Bands, Keltner Channel, expansion/contraction, volatility regime) computed LIVE by the connected MT5 EA for ANY symbol in its Market Watch. Replaces the retired DAVEMA /volatility endpoint.",
    parameters: { type: "object", properties: { symbol: { type: "string" }, timeframe: { type: "string" } }, required: ["symbol"] },
    execute: async (args, ctx) => requestAnalysis(ctx.userId, "volatility", args.symbol as string, (args.timeframe as string) ?? "M15"),
  },
];
