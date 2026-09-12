import {
  setRiskMode,
  setTradingMode,
  setActiveGroup,
  setFallbackGroup,
  setActivePairSymbol,
  clearActivePairSymbol,
  getTradingSession,
  setTradingSession,
  proposeSettingsChange,
  getAutoApprovalEnabled,
  setAutoApprovalEnabled,
  getSelfPauseEnabled,
  setSelfPauseEnabled,
  getConfidenceSettings,
  setConfidenceThreshold,
  setAutoApproveBelowThreshold,
  type RiskMode,
  type TradingMode,
  type TradingSession,
} from "@dave/trading";
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
  {
    name: "set_active_pair",
    description: "Narrow scanning/trading down to exactly ONE symbol (e.g. the user says 'just focus on EURUSD, not the whole group'). Overrides the active pair group's symbol list until cleared with clear_active_pair.",
    parameters: { type: "object", required: ["userId", "symbol"], properties: { userId: { type: "string" }, symbol: { type: "string" } } },
    execute: async (args) => {
      setActivePairSymbol(args.userId as string, args.symbol as string);
      return { ok: true };
    },
  },
  {
    name: "clear_active_pair",
    description: "Clear the single-pair override, going back to scanning the whole active pair group.",
    parameters: { type: "object", required: ["userId"], properties: { userId: { type: "string" } } },
    execute: async (args) => {
      clearActivePairSymbol(args.userId as string);
      return { ok: true };
    },
  },
  {
    name: "get_trading_session",
    description: "Get the user's real selected trading session (sydney/asian/london/new_york/all).",
    parameters: { type: "object", required: ["userId"], properties: { userId: { type: "string" } } },
    execute: async (args) => ({ session: getTradingSession(args.userId as string) }),
  },
  {
    name: "set_trading_session",
    description: "Set which real trading session the user wants Dave to trade during. 'all' means no restriction (trade any session).",
    parameters: { type: "object", required: ["userId", "session"], properties: { userId: { type: "string" }, session: { type: "string", enum: ["sydney", "asian", "london", "new_york", "all"] } } },
    execute: async (args) => {
      setTradingSession(args.userId as string, args.session as TradingSession);
      return { ok: true };
    },
  },
  {
    name: "propose_settings_change",
    description: "Propose a settings change on YOUR OWN initiative (e.g. you decided the user's SL should be tighter). Unless the user has enabled auto-approval, this sends them real colored Approve/Decline buttons and does NOT apply until they respond. A user's own direct settings command should use set_risk_mode instead, not this.",
    parameters: {
      type: "object",
      required: ["userId", "field", "mode", "reason"],
      properties: {
        userId: { type: "string" },
        field: { type: "string", enum: ["sl", "tp", "lot"] },
        mode: { type: "string", enum: ["off", "on", "auto"] },
        value: { type: "number" },
        reason: { type: "string" },
      },
    },
    execute: async (args) => proposeSettingsChange(args.userId as string, args.field as "sl" | "tp" | "lot", args.mode as RiskMode, args.value as number | undefined, args.reason as string),
  },
  {
    name: "get_auto_approval",
    description: "Check whether the user has enabled auto-approval (Dave applies its own proposed settings changes without asking).",
    parameters: { type: "object", required: ["userId"], properties: { userId: { type: "string" } } },
    execute: async (args) => ({ enabled: getAutoApprovalEnabled(args.userId as string) }),
  },
  {
    name: "set_auto_approval",
    description: "Turn auto-approval on/off for the user -- same setting a user can toggle themselves.",
    parameters: { type: "object", required: ["userId", "enabled"], properties: { userId: { type: "string" }, enabled: { type: "boolean" } } },
    execute: async (args) => {
      setAutoApprovalEnabled(args.userId as string, Boolean(args.enabled));
      return { ok: true };
    },
  },
  {
    name: "get_self_pause_enabled",
    description: "Check whether the autonomous bot is allowed to pause itself (up to 5 minutes) when it judges it already has enough open exposure.",
    parameters: { type: "object", required: ["userId"], properties: { userId: { type: "string" } } },
    execute: async (args) => ({ enabled: getSelfPauseEnabled(args.userId as string) }),
  },
  {
    name: "set_self_pause_enabled",
    description: "Turn the bot's ability to self-pause on/off. Off means it never self-pauses, no matter how much exposure it judges is open.",
    parameters: { type: "object", required: ["userId", "enabled"], properties: { userId: { type: "string" }, enabled: { type: "boolean" } } },
    execute: async (args) => {
      setSelfPauseEnabled(args.userId as string, Boolean(args.enabled));
      return { ok: true };
    },
  },
  {
    name: "get_confidence_settings",
    description: "Get the user's real confidence threshold (0-100) and whether trades below it auto-approve instead of requiring the user's explicit approval.",
    parameters: { type: "object", required: ["userId"], properties: { userId: { type: "string" } } },
    execute: async (args) => getConfidenceSettings(args.userId as string),
  },
  {
    name: "set_confidence_threshold",
    description: "Set the user's confidence threshold (0-100). trade_execute calls below this score require the user's approval unless auto-approve-below-threshold is on.",
    parameters: { type: "object", required: ["userId", "threshold"], properties: { userId: { type: "string" }, threshold: { type: "number" } } },
    execute: async (args) => setConfidenceThreshold(args.userId as string, args.threshold as number),
  },
  {
    name: "set_auto_approve_below_threshold",
    description: "Turn on/off auto-approval for trades below the user's confidence threshold -- same setting a user can toggle themselves in /settings.",
    parameters: { type: "object", required: ["userId", "enabled"], properties: { userId: { type: "string" }, enabled: { type: "boolean" } } },
    execute: async (args) => setAutoApproveBelowThreshold(args.userId as string, Boolean(args.enabled)),
  },
];
