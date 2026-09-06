import type { DavemaClient } from "@dave/davema";
import { processPriceTick, type Position } from "./breakeven-trailing.js";
import { getTrailingStopConfig, setTrailingStopConfig } from "./trailing-config.js";
import { registerTrailingPosition, unregisterTrailingPosition, listTrailingPositions } from "./trailing-runtime.js";
import { storeOwnMt5Credentials, getMaskedOwnMt5Credentials, deleteOwnMt5Credentials, setAccountChoice, getAccountChoice, type Mt5Credentials, type AccountChoice } from "./mt5-accounts.js";

/**
 * Update 18 (bulk tool-coverage expansion): trailing-stop config,
 * MT5 account selection, and a generic real DAVEMA query -- all had
 * real underlying functions but no agent-tool surface.
 */
export interface ExtraToolContext {
  userId: string;
  davema: DavemaClient;
}

export interface ExtraToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: ExtraToolContext) => Promise<unknown>;
}

export const TRAILING_TOOLS: ExtraToolDefinition[] = [
  {
    name: "get_trailing_stop_config",
    description: "Get your real stored default breakeven/trailing config (SL levels at TP1/TP2/TP3).",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => getTrailingStopConfig(ctx.userId),
  },
  {
    name: "set_trailing_stop_config",
    description: "Set your real default breakeven/trailing config.",
    parameters: { type: "object", properties: { slAtTp1: { type: "number" }, slAtTp2: { type: "number" }, slAtTp3: { type: "number" } }, required: ["slAtTp1", "slAtTp2", "slAtTp3"] },
    execute: async (args, ctx) => {
      setTrailingStopConfig(ctx.userId, { slAtTp1: args.slAtTp1 as number, slAtTp2: args.slAtTp2 as number, slAtTp3: args.slAtTp3 as number });
      return getTrailingStopConfig(ctx.userId);
    },
  },
  {
    name: "enable_position_trailing",
    description:
      "Opt a specific open position (by its real ticket) into REAL, running breakeven/trailing -- persisted, and actually driven " +
      "on every EA report from here on. Never automatic: only call this when you deliberately decide a setup calls for it, and only " +
      "for a position genuinely placed with TP1, TP2, AND TP3 (a single-TP trade is rejected, not partially enabled).",
    parameters: {
      type: "object",
      required: ["ticket", "direction", "entry", "sl", "tp1", "tp2", "tp3"],
      properties: {
        ticket: { type: "string" },
        direction: { type: "string", enum: ["buy", "sell"] },
        entry: { type: "number" },
        sl: { type: "number" },
        tp1: { type: "number" },
        tp2: { type: "number" },
        tp3: { type: "number" },
      },
    },
    execute: async (args, ctx) =>
      registerTrailingPosition(ctx.userId, args.ticket as string, {
        direction: args.direction as "buy" | "sell",
        entry: args.entry as number,
        sl: args.sl as number,
        tp1: args.tp1 as number,
        tp2: args.tp2 as number,
        tp3: args.tp3 as number,
        tp1Hit: false,
        tp2Hit: false,
        tp3Hit: false,
        breakevenTrailingEnabled: false,
      }),
  },
  {
    name: "disable_position_trailing",
    description: "Opt a real ticket OUT of the running breakeven/trailing registry.",
    parameters: { type: "object", required: ["ticket"], properties: { ticket: { type: "string" } } },
    execute: async (args, ctx) => ({ removed: unregisterTrailingPosition(ctx.userId, args.ticket as string) }),
  },
  {
    name: "list_trailing_positions",
    description: "List every real ticket currently registered for running breakeven/trailing, with its current stage flags.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => listTrailingPositions(ctx.userId),
  },
  {
    name: "process_price_tick",
    description: "Run one real price tick against an open position's breakeven/trailing stage logic.",
    parameters: { type: "object", properties: { position: { type: "object" }, currentPrice: { type: "number" }, config: { type: "object" } }, required: ["position", "currentPrice", "config"] },
    execute: async (args) => processPriceTick(args.position as Position, args.currentPrice as number, args.config as any),
  },
];

export const MT5_ACCOUNT_TOOLS: ExtraToolDefinition[] = [
  {
    name: "mt5_account",
    description: "Get or set which MT5 account you're using (Dave's default vs the user's own credentials) -- setting credentials stores them, getting returns only the masked login/server, never the real password.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "set_credentials", "delete_credentials", "set_choice"] },
        credentials: { type: "object" },
        choice: { type: "string", enum: ["dave-default", "own-account"] },
      },
      required: ["action"],
    },
    execute: async (args, ctx) => {
      if (args.action === "set_credentials") {
        storeOwnMt5Credentials(ctx.userId, args.credentials as Mt5Credentials);
        return { ok: true };
      }
      if (args.action === "delete_credentials") return { deleted: deleteOwnMt5Credentials(ctx.userId) };
      if (args.action === "set_choice") {
        setAccountChoice(ctx.userId, args.choice as AccountChoice);
        return { choice: getAccountChoice(ctx.userId) };
      }
      return { choice: getAccountChoice(ctx.userId), credentials: getMaskedOwnMt5Credentials(ctx.userId) };
    },
  },
];

/**
 * Item 5 real gap fixed: DAVEMA (the external market-data HTTP API) is retired -- these two
 * tools used to make a live HTTP call to it. `correlation_check`'s underlying /correlation
 * endpoint isn't ported to the new EA-based path yet (tracked as remaining work, honestly
 * reported rather than left silently calling a retired API), so it now fails loudly with a
 * clear message instead of a confusing network error against a dead endpoint. The real
 * replacement analysis tools (get_trend/get_momentum/get_volatility) live in
 * @dave/ea-bridge's tools.ts, not here -- that package already depends on this one, so putting
 * them here would create a circular package dependency.
 */
export const DAVEMA_TOOLS: ExtraToolDefinition[] = [
  {
    name: "correlation_check",
    description: "NOT YET AVAILABLE -- correlation analysis is being re-ported from the retired DAVEMA API to the new on-demand EA analysis tools (get_trend/get_momentum/get_volatility and more to come). Do not call this.",
    parameters: { type: "object", properties: { symbol: { type: "string" }, timeframe: { type: "string" } }, required: ["symbol"] },
    execute: async () => {
      throw new Error("correlation_check is not available yet -- DAVEMA (the old external API) is retired, and this specific check hasn't been re-ported to the new EA-based analysis tools yet.");
    },
  },
];
