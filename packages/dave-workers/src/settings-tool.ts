import { setRiskMode, setTradingMode, setActiveGroup, setFallbackGroup, type RiskMode, type TradingMode } from "@dave/trading";
import type { ToolDefinition } from "@dave/trading";

/**
 * Step 12.8: workers have a tool to edit user settings -- the SAME
 * permission Dave has, not locked out of it. These call the exact same
 * dave-trading functions Dave's own settings commands use; there is no
 * separate, weaker "worker version." Deliberately NOT gated by
 * toolsForWorker()'s trade-placing filter (Step 12.5) -- that filter is
 * specifically about opening/closing real trades, not settings.
 */
export const SETTINGS_TOOLS: ToolDefinition[] = [
  {
    name: "set_risk_mode",
    description: "Set SL/TP/lot mode to off/on/auto for the user. 'On' requires an explicit value.",
    parameters: {
      type: "object",
      required: ["userId", "field", "mode"],
      properties: {
        userId: { type: "string" },
        field: { type: "string", enum: ["sl", "tp", "lot"] },
        mode: { type: "string", enum: ["off", "on", "auto"] },
        value: { type: "number" },
      },
    },
    execute: async (args) => {
      setRiskMode(args.userId as string, args.field as "sl" | "tp" | "lot", args.mode as RiskMode, args.value as number | undefined);
      return { ok: true };
    },
  },
  {
    name: "set_trading_mode",
    description: "Switch the user between Auto and Trading Skills mode.",
    parameters: {
      type: "object",
      required: ["userId", "mode"],
      properties: { userId: { type: "string" }, mode: { type: "string", enum: ["auto", "trading-skills"] }, lockedSkillId: { type: "string" } },
    },
    execute: async (args) => {
      setTradingMode(args.userId as string, args.mode as TradingMode, args.lockedSkillId as string | undefined);
      return { ok: true };
    },
  },
  {
    name: "set_active_pair_group",
    description: "Set the user's active (or fallback) pair group.",
    parameters: {
      type: "object",
      required: ["userId", "groupId", "slot"],
      properties: { userId: { type: "string" }, groupId: { type: "string" }, slot: { type: "string", enum: ["active", "fallback"] } },
    },
    execute: async (args) => {
      if (args.slot === "active") setActiveGroup(args.userId as string, args.groupId as string);
      else setFallbackGroup(args.userId as string, args.groupId as string);
      return { ok: true };
    },
  },
];
