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
  getAnalysisConfig,
  resetAnalysisConfigToAll,
  setCustomTimeframes,
  setCustomEndpoints,
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
 *
 * Real bug fixed (five-agent bug-hunt pass, and it explains a symptom the trader has hit
 * repeatedly): every one of these tools used to declare `userId` as a REQUIRED parameter and read
 * `args.userId`, ignoring `ctx` entirely. But the model is never told the user's id -- it is not
 * in the system prompt and not in buildLiveSettingsBlock. So the model had to invent one. Every
 * settings write then landed under a hallucinated key and returned `{ ok: true }`, so Dave would
 * cheerfully confirm "SL set to 15 pips" while the real stored setting never changed. That is
 * exactly the "I set it and it didn't stick" class live-context.ts was already written to fix
 * from the other direction.
 *
 * Whose settings these are is never the model's decision to make, so `userId` is gone from the
 * schemas entirely and every tool now uses `ctx.userId` -- the same real, authenticated owner id
 * the rest of the loop threads through. This also closes the matching hole where a model could
 * name ANY id and mutate settings that were not its caller's.
 */
export const SETTINGS_TOOLS: ToolDefinition[] = [
  {
    name: "set_risk_mode",
    description: "Set SL/TP/lot mode to off/on/auto for the user. 'On' requires an explicit value.",
    parameters: {
      type: "object",
      required: ["field", "mode"],
      properties: {
        field: { type: "string", enum: ["sl", "tp", "lot"] },
        mode: { type: "string", enum: ["off", "on", "auto"] },
        value: { type: "number" },
      },
    },
    execute: async (args, ctx) => {
      setRiskMode(ctx.userId, args.field as "sl" | "tp" | "lot", args.mode as RiskMode, args.value as number | undefined);
      return { ok: true };
    },
  },
  {
    name: "set_trading_mode",
    description: "Switch the user between Auto and Trading Skills mode.",
    parameters: {
      type: "object",
      required: ["mode"],
      properties: { mode: { type: "string", enum: ["auto", "trading-skills"] }, lockedSkillId: { type: "string" } },
    },
    execute: async (args, ctx) => {
      setTradingMode(ctx.userId, args.mode as TradingMode, args.lockedSkillId as string | undefined);
      return { ok: true };
    },
  },
  {
    name: "set_active_pair_group",
    description: "Set the user's active (or fallback) pair group.",
    parameters: {
      type: "object",
      required: ["groupId", "slot"],
      properties: { groupId: { type: "string" }, slot: { type: "string", enum: ["active", "fallback"] } },
    },
    execute: async (args, ctx) => {
      if (args.slot === "active") setActiveGroup(ctx.userId, args.groupId as string);
      else setFallbackGroup(ctx.userId, args.groupId as string);
      return { ok: true };
    },
  },
  {
    name: "set_active_pair",
    description: "Narrow scanning/trading down to exactly ONE symbol (e.g. the user says 'just focus on EURUSD, not the whole group'). Overrides the active pair group's symbol list until cleared with clear_active_pair.",
    parameters: { type: "object", required: ["symbol"], properties: { symbol: { type: "string" } } },
    execute: async (args, ctx) => {
      setActivePairSymbol(ctx.userId, args.symbol as string);
      return { ok: true };
    },
  },
  {
    name: "clear_active_pair",
    description: "Clear the single-pair override, going back to scanning the whole active pair group.",
    parameters: { type: "object", properties: {} },
    execute: async (args, ctx) => {
      clearActivePairSymbol(ctx.userId);
      return { ok: true };
    },
  },
  {
    name: "get_trading_session",
    description: "Get the user's real selected trading session (sydney/asian/london/new_york/all).",
    parameters: { type: "object", properties: {} },
    execute: async (args, ctx) => ({ session: getTradingSession(ctx.userId) }),
  },
  {
    name: "set_trading_session",
    description: "Set which real trading session the user wants Dave to trade during. 'all' means no restriction (trade any session).",
    parameters: { type: "object", required: ["session"], properties: { session: { type: "string", enum: ["sydney", "asian", "london", "new_york", "all"] } } },
    execute: async (args, ctx) => {
      setTradingSession(ctx.userId, args.session as TradingSession);
      return { ok: true };
    },
  },
  {
    name: "propose_settings_change",
    description: "Propose a settings change on YOUR OWN initiative (e.g. you decided the user's SL should be tighter). Unless the user has enabled auto-approval, this sends them real colored Approve/Decline buttons and does NOT apply until they respond. A user's own direct settings command should use set_risk_mode instead, not this.",
    parameters: {
      type: "object",
      required: ["field", "mode", "reason"],
      properties: {
        field: { type: "string", enum: ["sl", "tp", "lot"] },
        mode: { type: "string", enum: ["off", "on", "auto"] },
        value: { type: "number" },
        reason: { type: "string" },
      },
    },
    execute: async (args, ctx) => proposeSettingsChange(ctx.userId, args.field as "sl" | "tp" | "lot", args.mode as RiskMode, args.value as number | undefined, args.reason as string),
  },
  {
    name: "get_auto_approval",
    description: "Check whether the user has enabled auto-approval (Dave applies its own proposed settings changes without asking).",
    parameters: { type: "object", properties: {} },
    execute: async (args, ctx) => ({ enabled: getAutoApprovalEnabled(ctx.userId) }),
  },
  {
    name: "set_auto_approval",
    description: "Turn auto-approval on/off for the user -- same setting a user can toggle themselves.",
    parameters: { type: "object", required: ["enabled"], properties: { enabled: { type: "boolean" } } },
    execute: async (args, ctx) => {
      setAutoApprovalEnabled(ctx.userId, Boolean(args.enabled));
      return { ok: true };
    },
  },
  {
    name: "get_self_pause_enabled",
    description: "Check whether the autonomous bot is allowed to pause itself (up to 5 minutes) when it judges it already has enough open exposure.",
    parameters: { type: "object", properties: {} },
    execute: async (args, ctx) => ({ enabled: getSelfPauseEnabled(ctx.userId) }),
  },
  {
    name: "set_self_pause_enabled",
    description: "Turn the bot's ability to self-pause on/off. Off means it never self-pauses, no matter how much exposure it judges is open.",
    parameters: { type: "object", required: ["enabled"], properties: { enabled: { type: "boolean" } } },
    execute: async (args, ctx) => {
      setSelfPauseEnabled(ctx.userId, Boolean(args.enabled));
      return { ok: true };
    },
  },
  {
    name: "get_analysis_config",
    description: "Get the user's real analysis scope -- whether get_all_analysis sends every endpoint/timeframe (the default, 'all') or a user-narrowed 'custom' subset.",
    parameters: { type: "object", properties: {} },
    execute: async (args, ctx) => getAnalysisConfig(ctx.userId),
  },
  {
    name: "set_analysis_scope_all",
    description: "Reset the analysis scope back to sending EVERY endpoint and timeframe -- the real default.",
    parameters: { type: "object", properties: {} },
    execute: async (args, ctx) => resetAnalysisConfigToAll(ctx.userId),
  },
  {
    name: "set_analysis_timeframes",
    description: "Narrow which real timeframes (from H4/H1/M15/M5/M3/M1) get_all_analysis fetches, switching scope to 'custom'.",
    parameters: { type: "object", required: ["timeframes"], properties: { timeframes: { type: "array", items: { type: "string" } } } },
    execute: async (args, ctx) => setCustomTimeframes(ctx.userId, args.timeframes as string[]),
  },
  {
    name: "set_analysis_endpoints",
    description: "Narrow which real analysis endpoints (e.g. trend, momentum, structure, ichimoku, ...) get_all_analysis includes, switching scope to 'custom'.",
    parameters: { type: "object", required: ["endpoints"], properties: { endpoints: { type: "array", items: { type: "string" } } } },
    execute: async (args, ctx) => setCustomEndpoints(ctx.userId, args.endpoints as string[]),
  },
  {
    name: "get_confidence_settings",
    description: "Get the user's real confidence threshold (0-100) and whether trades below it auto-approve instead of requiring the user's explicit approval.",
    parameters: { type: "object", properties: {} },
    execute: async (args, ctx) => getConfidenceSettings(ctx.userId),
  },
  {
    name: "set_confidence_threshold",
    description: "Set the user's confidence threshold (0-100). trade_execute calls below this score require the user's approval unless auto-approve-below-threshold is on.",
    parameters: { type: "object", required: ["threshold"], properties: { threshold: { type: "number" } } },
    execute: async (args, ctx) => setConfidenceThreshold(ctx.userId, args.threshold as number),
  },
  {
    name: "set_auto_approve_below_threshold",
    description: "Turn on/off auto-approval for trades below the user's confidence threshold -- same setting a user can toggle themselves in /settings.",
    parameters: { type: "object", required: ["enabled"], properties: { enabled: { type: "boolean" } } },
    execute: async (args, ctx) => setAutoApproveBelowThreshold(ctx.userId, Boolean(args.enabled)),
  },
];
