import type { DavemaClient } from "@dave/davema";
import { processPriceTick, enableBreakevenTrailing, disableBreakevenTrailing, type Position } from "./breakeven-trailing.js";
import { getTrailingStopConfig, setTrailingStopConfig } from "./trailing-config.js";
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
    name: "toggle_breakeven_trailing",
    description: "Opt a specific open position in/out of breakeven-trailing -- never automatic, only per-position when you decide the setup calls for it.",
    parameters: { type: "object", properties: { position: { type: "object" }, enabled: { type: "boolean" } }, required: ["position", "enabled"] },
    execute: async (args) => (args.enabled ? enableBreakevenTrailing(args.position as Position) : disableBreakevenTrailing(args.position as Position)),
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

export const DAVEMA_TOOLS: ExtraToolDefinition[] = [
  {
    name: "davema",
    description: "Real, direct DAVEMA query -- any of the 46 real endpoints (structure/liquidity/confluence/etc), for a symbol/timeframe.",
    parameters: { type: "object", properties: { endpoint: { type: "string" }, symbol: { type: "string" }, timeframe: { type: "string" } }, required: ["endpoint", "symbol"] },
    execute: async (args, ctx) => ctx.davema.data(args.endpoint as any, args.symbol as string, (args.timeframe as string) ?? "M15"),
  },
  {
    name: "correlation_check",
    description: "Real DAVEMA /correlation check for a symbol before sizing -- warns if it's secretly correlated with an existing position's pair.",
    parameters: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
    execute: async (args, ctx) => ctx.davema.data("correlation" as any, args.symbol as string),
  },
];
