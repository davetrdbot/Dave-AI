import type { DaveDatabase } from "@dave/db";
import type { Provider, ToolSpec } from "@dave/brain";
import { getModelConfig, listProviderKeys, type ProviderName } from "@dave/brain";
import type { TradeExecutor, OrderRequest, OrderType, RiskSettings } from "@dave/trading";
import { getActiveStrategySkillId, getPullbackMode, isSymbolAvoided, isLimitType, planPullbackScalp, placePullbackScalp, describePullbackScalp, pullbackScalpRoom } from "@dave/trading";
import { getSkill } from "@dave/skills";
import {
  getRiskSettings,
  getActiveGroupInfo,
  getConfidenceSettings,
  evaluateConfidenceGate,
  queueTradeForApproval,
  tradeExecute,
  tradeExecuteWithMarginRetry,
  derivePipSize,
  assessRiskRewardForUser,
  getMinRiskReward,

  InsufficientMarginError,
  ABSOLUTE_MIN_LOTS,
  tradeModify,
  partialClose,
  fullClose,
  deletePendingOrder,
  huntForSetup,
  isWithinSelectedSession,
  ensureGroupsUsable,
  isMarketOpenForSymbol,
  consumeScanRestart,
  getThinkOnAlertScans,
  getEnabledThinkingStages,
  isSlTooTight,
  getSelfPauseEnabled,
  getAnalysisConfig,
  filterSuiteToConfig,
  getTwoStepTradingEnabled,
  getSequentialThinkingEnabled,
  getSequentialThinkingEffort,
  isForexSymbol,
  evaluateAccountAwareness,
  ALL_ANALYSIS_TIMEFRAMES,
  isAnalysisScopeSufficientFor,
  isAvoidedByStrategy,
  growthContextBlock,
  recordDecisionForGrading,
  pastCallsBlock,
} from "@dave/trading";
import { isTradingHalted } from "@dave/safety";
import { getLastKnownAccountSnapshot, getLastKnownState, createEaAnalysisSource } from "@dave/ea-bridge";
import { logTrade, getTradeLifecycle } from "@dave/feedback";
import { runScriptInE2B } from "@dave/e2b";
import { createReminder, deleteReminder, listReminders, formatReminderLine } from "@dave/workers";
import {
  recordTickDecision,
  formatRecentDecisions,
  getCursorPosition,
  advanceCursor,
  recordSkipForHunt,
  clearHuntState,
  HUNT_THRESHOLD,
  setPendingSymbolOverride,
  consumePendingSymbolOverride,
  resetScanCursor,
  takeAlertFocus,
  peekAlertFocus,
} from "./autonomous-tick-state.js";
import { isAutonomousExecutionEnabled } from "./autonomous-trading-state.js";
import { setSelfPause, getSelfPause, MAX_SELF_PAUSE_MINUTES } from "./self-pause.js";
import { recordAnalysisFetch } from "./analysis-debug-store.js";
import { buildTradePlacedMessage, buildTradeApprovalRequestMessage, buildSniperTierWhileStoppedMessage, summarizeReason, buildProgressBar } from "./trade-notifications.js";
import { tradeApprovalKeyboard, type InlineKeyboardMarkup } from "@dave/telegram";
import { loadSystemPrompt } from "./system-prompt.js";
import { consultJournal } from "./journal-agent.js";
import { consultFlo } from "./flo-agent.js";
import { computeMtfAlignment, computeMtfConfluenceScore, computeBasketCurrencyRisk, computeSpreadNewsRisk } from "./mtf-confluence.js";
import { runSequentialThinking } from "./sequential-thinking.js";
import { buildClockLine } from "./live-context.js";
import { loadFrozenSnapshot } from "@dave/memory";
import { BENCH_HOURS, isSymbolUnavailable, recordHasData, recordNoData } from "./symbol-availability.js";
import { activeAiOutage, aiSetupFingerprint, clearAiOutage, markAiOutage } from "./ai-outage.js";
import { slProgress as directionalSlProgress } from "./trade-monitor-store.js";
import { selfAwareFeedBlock } from "./self-aware-feed.js";
import { growthStatus } from "./growth-reflection.js";
import { knowledgeList, knowledgeView } from "@dave/knowledge";
import { publishActivity } from "./activity-bus.js";
import { holdOrClose, protectInstead } from "./hold-to-plan.js";
import { ownerTag } from "./trade-owner.js";
import { describeApa } from "./apa-structure.js";
import { tradeDrawing } from "./setup-drawing.js";
import { getAutoDrawTrades } from "@dave/trading";
import { resolveTradeLevels, levelsGuidance, exitPrice, type TradeLevels, type TradeAction as LevelAction } from "./trade-levels.js";
import { parseCandles } from "./decision-grading.js";
import { ACTIONS_SCHEMA, coerceTickActions, gatherData, isDataAction, runManagementActions, type TickAction } from "./tick-actions.js";

/** Bounded so a growing knowledge store can never crowd out the analysis suite in the tick's
 *  prompt. Entries past the budget are listed by title only -- truncated, never silently dropped. */
const TICK_KNOWLEDGE_CHAR_BUDGET = 8_000;

/** Neither store may ever be able to fail a trading cycle. */
function safeTickMemory(userId: string): string | undefined {
  try {
    const snapshot = loadFrozenSnapshot(userId);
    const sections = [snapshot.memory?.trim(), snapshot.user?.trim(), snapshot.adaptability?.trim()].filter(
      (s): s is string => Boolean(s)
    );
    return sections.length > 0 ? sections.join("\n") : undefined;
  } catch (err) {
    console.error(`[tick] could not load memory for ${userId} -- continuing without it:`, err);
    return undefined;
  }
}

/**
 * Unlike the chat path, this includes each entry's real CONTENT, not just an index. The tick's
 * model call forces toolChoice to the decision tool, so it can never follow an index up with a
 * knowledge_view -- a title-only list here would be strictly worse than nothing, telling the model
 * a lesson exists while withholding it.
 */
function safeTickKnowledgeIndex(userId: string): string | undefined {
  try {
    const entries = knowledgeList(userId);
    if (entries.length === 0) return undefined;
    const parts: string[] = [];
    let used = 0;
    for (const entry of entries) {
      const full = knowledgeView(userId, entry.id);
      const body = full?.content?.trim() ?? "";
      const block = `- ${entry.title} (use when: ${entry.useWhen})\n  ${body}`;
      if (used + block.length > TICK_KNOWLEDGE_CHAR_BUDGET) {
        parts.push(`- ${entry.title} (use when: ${entry.useWhen}) [not shown -- knowledge budget reached]`);
        continue;
      }
      used += block.length;
      parts.push(block);
    }
    return parts.join("\n");
  } catch (err) {
    console.error(`[tick] could not load knowledge for ${userId} -- continuing without it:`, err);
    return undefined;
  }
}

/** Dave's reminders for the cycle: pending ones, and ones that fired recently and still wait on
 *  him. Same fail-safe contract as the knowledge loader -- a bad store costs the cycle nothing. */
export function buildTickRemindersLine(userId: string, now = Date.now(), symbol?: string): string | null {
  try {
    // With a symbol: only that pair's reminders and general ones (no pair) -- another pair's
    // reminder gets its own scan when it fires.
    const reminders = listReminders(userId, { includeFired: true }, now).filter((r) => !symbol || !r.symbol || r.symbol.toUpperCase() === symbol.toUpperCase());
    if (reminders.length === 0) return null;
    const fired = reminders.filter((r) => r.status === "fired");
    const pending = reminders.filter((r) => r.status === "pending");
    const parts = ["YOUR REMINDERS (notes you set for yourself -- set more with setReminder, remove with deleteReminderIds):"];
    if (fired.length > 0) {
      parts.push(`Fired and waiting on you -- act on each now if it still applies, then put its id in deleteReminderIds:`, ...fired.map((r) => formatReminderLine(r, now)));
    }
    if (pending.length > 0) parts.push("Pending:", ...pending.map((r) => formatReminderLine(r, now)));
    return parts.join("\n");
  } catch (err) {
    console.error(`[tick] could not load reminders for ${userId} -- continuing without them:`, err);
    return null;
  }
}

/**
 * Real replacement for the autonomous cycle's open-ended agentic tool-calling loop, modeled
 * directly on the user's own former bot's proven `tickOne()` (auto-trade-tick/index.ts): one
 * structured decision per cycle, not a multi-turn conversation the model can narrate a halt or a
 * hedge into. A single request with exactly one tool the model MUST call (not an open-ended
 * toolbox) removes the failure class that let Dave invent its own authority to halt trading,
 * forget trades it had just placed, and hedge on real setups.
 *
 * Real upgrade this session (user, live, explicit spec): the system now pushes ONE symbol's full
 * analysis at a time, round-robin through the whole active group (not "whichever symbol happens
 * to be first and eligible") -- see autonomous-tick-state.ts's cursor. The decision itself is a
 * real tool call (not free-text-JSON parsing) whose schema is built fresh each tick from the
 * user's actual SL/TP mode -- sl/tp become REQUIRED fields in the schema when mode is "auto",
 * omitted entirely when "off" -- so "ask for TP/SL only when auto" is a real JSON-schema
 * constraint, not a prose request the model can ignore. Falls back to text-JSON parsing for a
 * provider that doesn't return a tool call.
 *
 * Extended again this session (user, live, four more real problems): the decision's action set now
 * also covers managing an EXISTING position (DELETE_TICKET/PARTIAL_CLOSE) and self-pausing
 * (PAUSE) -- still exactly one forced tool call per cycle, the architecture is never reopened into
 * a multi-tool agentic loop. Real per-symbol market hours (forex only, for now), real ATR-relative
 * SL sanity, real max-open-trades enforcement, and a final gate check right before order execution
 * (closing a real /stop_trading race where an in-flight cycle could still fire after the user
 * stopped trading) are all new here too.
 *
 * This module owns the DECISION only. Scheduling (trading-loop.ts, compulsory 1-minute cadence)
 * and the top-level safety gates (isTradingHalted, EA connection, pending question, circuit
 * breaker, drawdown) stay exactly as they are in telegram-bot-server.ts -- this is what runs
 * once those have already passed.
 */

/** Real multi-timeframe set requested per symbol, per tick -- see the real reason at this
 *  constant's one call site below: the EA's "all" endpoint computes against a single timeframe
 *  only, so genuine multi-timeframe alignment means genuinely asking more than once. User's
 *  original spec: M1/M3/M5 for the scalper's short-term read, M15/H1 for the mid-term picture,
 *  H4 for the sniper's higher-timeframe context -- all genuinely confirmed supported by the EA's
 *  own TimeframeFromString (ea/DaveEA.mq5).
 *
 *  Real bug fixed (live Railway logs, the trader's real account: every cycle all day SKIPping at
 *  0% confidence -- "Active strategy is HTF Top-Down Pullback, which requires a complete
 *  D1->H4->H1->M15->M5 flow"): this used to be its own hand-duplicated array that never had D1 in
 *  it at all -- a strategy skill added AFTER this constant was written needed a timeframe this
 *  default fetch could never supply, no matter how the analysis config was set. Now imported from
 *  dave-trading's own single real source (ALL_ANALYSIS_TIMEFRAMES, analysis-config.ts) instead of
 *  a second hand-copied list that could drift out of sync with it again exactly like this. */
const ANALYSIS_TIMEFRAMES = ALL_ANALYSIS_TIMEFRAMES;

/** Bounded on purpose: this is one extra step inside a trading cycle that already has real EA
 *  round trips ahead of it, so a script that hasn't answered in this long is costing the cycle more
 *  than its answer is worth. Matches the REQUEST_CANDLES fetch budget. */
const TICK_SCRIPT_TIMEOUT_MS = 60_000;

/** Builds the honest warning line when the active strategy skill names timeframes the current
 *  analysis scope will not fetch, so an unsatisfiable strategy announces itself instead of
 *  producing an endless, error-free stand-down. Returns null when the scope genuinely covers it. */
function scopeWarningFor(userId: string, skillContent: string): string | null {
  const check = isAnalysisScopeSufficientFor(userId, skillContent);
  if (check.sufficient) return null;
  console.warn(`[autonomous-tick] ${userId}: active strategy names ${check.missing.join(", ")}, which the analysis scope does NOT fetch (scope: ${check.active.join(", ")}) -- the strategy cannot be followed as written`);
  return (
    `SCOPE WARNING: this strategy's own instructions reference ${check.missing.join(", ")}, but your analysis scope does not fetch ${check.missing.length === 1 ? "it" : "them"} -- you are receiving ${check.active.join(", ")} only, and no amount of waiting will produce the missing data. ` +
    `Do NOT stand down cycle after cycle waiting for a timeframe that will never arrive. Either judge the setup on the timeframes you genuinely have and say in your reason that you did so, or, if the strategy truly cannot be followed without ${check.missing.join(", ")}, use ASK to tell the user their strategy and their analysis scope disagree and which they want changed.`
  );
}

const TRADE_ACTIONS = ["BUY", "SELL", "BUY_LIMIT", "SELL_LIMIT", "BUY_STOP", "SELL_STOP"] as const;
type TradeAction = (typeof TRADE_ACTIONS)[number];
/** Real gap fixed (user, live: "add a tool to delete the existing trade... a tool that the bot
 *  can pause... a tool like partial close"). Kept inside the SAME one-forced-tool-call schema as
 *  the trade actions -- these are alternate values of the one `action` field, not a second tool
 *  the model can freely reach for, so the "one structured decision per tick" architecture is
 *  never reopened into an agentic multi-tool loop. */
const MANAGEMENT_ACTIONS = ["DELETE_TICKET", "PARTIAL_CLOSE", "MODIFY", "PAUSE", "CONSULT_JOURNAL", "REQUEST_CANDLES", "RUN_SCRIPT"] as const;
const DECISION_ACTIONS = [...TRADE_ACTIONS, ...MANAGEMENT_ACTIONS, "SKIP", "ASK"] as const;
type DecisionAction = (typeof DECISION_ACTIONS)[number];
/** Aux actions that ask for another round -- not allowed as the answer to a gather round. */
const MANAGEMENT_AUX_ACTIONS = ["CONSULT_JOURNAL", "REQUEST_CANDLES", "RUN_SCRIPT"] as const;

const ACTION_TO_ORDER_TYPE: Record<TradeAction, OrderType> = {
  BUY: "buy",
  SELL: "sell",
  BUY_LIMIT: "buy_limit",
  SELL_LIMIT: "sell_limit",
  BUY_STOP: "buy_stop",
  SELL_STOP: "sell_stop",
};

/** Real, confirmed bar (user, live): a trade action at/above this confidence, decided while
 *  autonomous trading is stopped, is exceptional enough to interrupt the user for an explicit
 *  approve/decline rather than either firing on its own or staying silent. */
const SNIPER_TIER_CONFIDENCE = 85;

/** Real, live-stated bar (user's own upgrade request, exact: "when a trade is reaching 50% toward
 *  the SL it should alert" -- lowered from the earlier 89%). Real SL-progress -- genuine distance
 *  travelled from a real open position's entry toward its real SL, as a fraction of the real
 *  entry-to-SL distance (see buildProgressBar in trade-notifications.ts, the same math the visual
 *  bar renders) -- at or beyond this 50%+ fraction triggers the SELF-AWARE ALERT context line
 *  below, for ANY open position account-wide, not just the current round-robin symbol's own
 *  position. The SAME threshold now also drives the standalone, edge-triggered proactive alert
 *  (self-aware-sweep.ts) that fires even when autonomous trading is OFF or between ticks. */
const SL_DANGER_THRESHOLD = 0.5;

export interface TickDecision {
  action: DecisionAction;
  symbol?: string;
  /** Required for BUY_LIMIT/SELL_LIMIT/BUY_STOP/SELL_STOP; unused for market BUY/SELL. */
  entry?: number;
  sl?: number;
  tp?: number;
  /** With TP off: where the model expects price to go. Never placed -- the floor is checked on it. */
  target?: number;
  lots?: number;
  confidence?: number;
  reason?: string;
  /** Real, live fix (user: the MT5 comment used to cram as much of the real `reason` text as fit
   *  into 40 chars, reading as garbled/cut-off mid-word/mid-sentence on the MT5 side). A SHORT
   *  strategy/setup label the model fills in alongside `reason` on a real trade decision -- e.g.
   *  "Bullish engulfing", "ICT OB", "Liquidity sweep" -- used to build a short, structured MT5
   *  comment (`Dave:67% Bullish engulfing`) instead of a truncated slice of the real reasoning.
   *  The full, real `reason` still goes out in full elsewhere (the Telegram push notification);
   *  this field is only ever for the space-constrained MT5 comment. */
  strategyTag?: string;
  question?: string;
  options?: string[];
  /** With BUY_LIMIT/SELL_LIMIT: the pullback scalp that rides price into the limit (see
   *  pullback-scalp.ts). Dave's own SL and TP2 for it; TP1 is always the limit entry itself. */
  pullbackScalp?: { sl?: number; tp2?: number };
  /** Required for DELETE_TICKET/PARTIAL_CLOSE -- the real ticket to act on. */
  ticket?: string;
  /** Required for PARTIAL_CLOSE -- how many lots of the position to close. */
  closeLots?: number;
  /** Optional for PAUSE, clamped to [1, MAX_SELF_PAUSE_MINUTES]; defaults to the max if omitted. */
  pauseMinutes?: number;
  /** Optional for MODIFY -- the position's new SL. `null` explicitly removes the SL; omitted/undefined leaves it unchanged. Matches tradeModify's real semantics exactly. */
  newSl?: number | null;
  /** Optional for MODIFY -- the position's new TP. `null` explicitly removes the TP; omitted/undefined leaves it unchanged. Matches tradeModify's real semantics exactly. */
  newTp?: number | null;
  /** Optional on ANY decision (not a separate action) -- requests a SPECIFIC symbol for the NEXT
   *  cycle instead of the mechanical round-robin order, e.g. "check back on this once a candle
   *  closes" or "keep an eye on this related pair after the trade just taken". Honored by
   *  resolveCursorSymbol on the very next tick, consumed exactly once, and only if the requested
   *  symbol is still genuinely valid to analyze then (see autonomous-tick-state.ts's
   *  pendingSymbolOverride). */
  requestedNextSymbol?: string;
  /** The real reason accompanying `requestedNextSymbol` -- required alongside it to mean anything,
   *  logged whenever the override is honored or skipped. */
  requestedNextReason?: string;
  /** Required for RUN_SCRIPT -- the real script to execute before re-deciding. Deliberately a
   *  field on the ONE decision tool, exactly like every other action here, rather than a second
   *  tool the model may reach for freely: the "one structured decision per tick" architecture
   *  stays closed, and the script costs a strictly bounded single extra round trip. */
  script?: string;
  /** Language for `script`. Defaults to python, which is what nearly every real calculation here
   *  wants. */
  scriptLanguage?: "bash" | "python" | "node";
  /** Optional on ANY decision (the trader: reminders must work "in the analyzing part" too) -- a
   *  note to Dave's future self, with the reason behind it. */
  setReminder?: { text: string; reason: string; inMinutes: number; symbol?: string };
  /** Optional on ANY decision -- ids of reminders to remove (dealt with, or no longer relevant). */
  deleteReminderIds?: string[];
  /** Optional on ANY decision -- several things at once (see tick-actions.ts). */
  actions?: TickAction[];
}

export interface TickOutcome {
  action: DecisionAction | "NONE";
  symbol?: string;
  /** Set when a real trade-affecting event happened this tick -- the caller uses this to decide whether to message the user. */
  notable: boolean;
  message?: string;
  /** Real bug fixed (the owner, live Telegram screenshot): a tick that queues a trade for the
   *  owner's approval used to return ONLY the "Approve to place it, or decline to skip." text,
   *  and telegram-bot-server.ts sent it as a plain message -- so the prompt arrived with no
   *  buttons on it and there was nothing the owner could actually press. The real keyboard now
   *  travels with the outcome and is attached by that same send path (on the LAST chunk, exactly
   *  like full-registry.ts's trade_execute wrapper does for the interactive path). */
  replyMarkup?: InlineKeyboardMarkup;
  huntModeActivated?: boolean;
}

const DECISION_TOOL_NAME = "submit_trading_decision";

/** Built fresh every tick from the real current risk settings -- sl/tp are only ever REQUIRED
 *  in the schema when their mode is genuinely "auto"; omitted from the schema entirely when
 *  "off" (nothing to ask for); present but optional when "on" (the server applies the fixed
 *  value regardless of what's passed). This is the real mechanism behind "ask for TP/SL if set
 *  to auto, but off it won't ask."
 *
 *  Real bug fixed (confirmed live: a genuinely good BUY decision -- "Aligned multi-TF bull... "
 *  62% confidence -- got silently thrown away as "no valid lot size" because `lots` was in
 *  `properties` but never added to `required`, unlike sl/tp above. Unlike sl/tp, lots has no real
 *  "off" state -- a trade always needs a size, and the order-building logic below only ever uses
 *  the fixed `risk.lotValue` when mode is "on"; every other mode falls through to whatever the
 *  model supplied, so it must be required whenever mode isn't "on". */
/**
 * Real bug fixed (the trader: "the models still tends to follow the risk:reward via prompt, so fix
 * that -- it should obey the settings own").
 *
 * The floor WAS genuinely enforced -- runAutonomousTick rejects a bad structure before it reaches
 * the broker -- but the model choosing the stop and target was never told what the floor is. The
 * tick's context carried SL/TP/lot modes and the confidence threshold and simply omitted this one
 * setting, so the model fell back on the prompt's general "a target that pays more than its stop
 * risks" (effectively 1:1) and produced trades that were then refused after the fact. From the
 * trader's side that reads exactly as "it follows the prompt, not my setting".
 *
 * The number is now stated where the numbers are actually chosen -- on the sl and tp fields
 * themselves -- as well as in the context block below.
 */
function buildDecisionTool(risk: RiskSettings, minRiskReward: number): ToolSpec {
  const properties: Record<string, unknown> = {
    action: {
      type: "string",
      enum: DECISION_ACTIONS,
      description:
        "BUY/SELL are market orders. BUY_LIMIT/SELL_LIMIT/BUY_STOP/SELL_STOP are real pending orders -- include entry. " +
        "DELETE_TICKET removes an existing pending order (needs ticket) -- it NEVER closes an open trade: you don't close trades, the stop and target do (a close order on an open trade is refused; a winner gets breakeven instead). " +
        "PARTIAL_CLOSE is refused too -- you never cut a trade, not even part of it. " +
        "MODIFY adjusts SL/TP on an existing open position (needs ticket; optional newSl/newTp -- pass a number to set it, null to explicitly remove it, or omit to leave it unchanged). " +
        "PAUSE stops you from opening new trades for a short while when you judge exposure is already high (optional pauseMinutes, 1-5). " +
        "CONSULT_JOURNAL asks Journal, your trade-review sidekick, for a second opinion before you commit -- optional, never required; you'll be asked to decide again right after with its answer in hand. " +
        "REQUEST_CANDLES fetches one fresh real batch of candles (for the at-risk symbol if a SELF-AWARE ALERT is active below, otherwise for the symbol you're currently analyzing) so you decide with current price action, not stale data -- optional, never required, available on any cycle, at most once; you'll be asked to decide again right after with the candles in hand. " +
        "RUN_SCRIPT runs one real script (needs script) against this symbol's full analysis suite and hands you its actual output before you decide -- use it ONLY when the decision genuinely turns on a number you cannot reliably work out in your head, and never as a routine step; optional, never required, at most once; you'll be asked to decide again right after with the output in hand. " +
        "Never ASK for anything already in front of you -- an open trade's entry, SL, TP, ticket, lots or P&L are all in OPEN POSITIONS below; to move a stop to breakeven use MODIFY (or the breakeven action) directly. " +
        "SKIP if there's genuinely nothing. ASK for real, specific ambiguity -- and ASK when the SAME blocker (a saved lesson, a setting, an account limit) has now stopped you trading for several cycles in a row: tell the trader plainly which lesson or limit it is, what it keeps stopping, and what they could decide. Say it once; if your recent decisions show you already asked, keep going without repeating it.",
    },
    symbol: { type: "string" },
    script: {
      type: "string",
      description:
        "Required when action is RUN_SCRIPT. A complete standalone program. This symbol's full analysis suite is written into the sandbox as market.json (at $DAVE_IN_DIR/market.json) -- read it from there. Print what you need to your output. NOTE: this symbol is a synthetic pair that exists only in this terminal and on no public API, so never try to fetch its price from the internet.",
    },
    scriptLanguage: { type: "string", enum: ["bash", "python", "node"], description: "Language for script. Defaults to python." },
    entry: { type: "number", description: "Required for a pending order type (BUY_LIMIT/SELL_LIMIT/BUY_STOP/SELL_STOP). Omit for market BUY/SELL." },
    pullbackScalp: {
      type: "object",
      description:
        "OPTIONAL, with BUY_LIMIT/SELL_LIMIT only, and only when it's worth it (omit it when the account is already busy or leveraged, or TP1 can't pay the floor). " +
        "The pullback scalp opened at market the moment the limit is placed, riding price INTO the limit. " +
        "Under a SELL_LIMIT it is a BUY; over a BUY_LIMIT it is a SELL. TP1 is the limit entry exactly (set automatically). " +
        "Give sl (where the pullback idea is wrong, from structure) and tp2 (PAST the limit entry -- the overshoot/sweep through the level -- but short of the limit's own SL). " +
        "TP1 must pay at least the risk:reward floor against this sl.",
      properties: { sl: { type: "number" }, tp2: { type: "number" } },
    },
    lots: { type: "number", description: "Required unless the account has a fixed lot size configured -- size your own real lots against the live account balance." },
    confidence: { type: "number", description: "your own honest 0-100 confidence in this specific setup" },
    reason: { type: "string" },
    strategyTag: {
      type: "string",
      description:
        "a SHORT strategy/setup label, e.g. 'Bullish engulfing', 'ICT OB', 'Liquidity sweep' -- a few words, never a full sentence. " +
        "Used to build the short MT5 order comment alongside your confidence -- your full real reasoning belongs in `reason`, not here.",
    },
    question: { type: "string", description: "only when action is ASK" },
    options: { type: "array", items: { type: "string" }, description: "only when action is ASK" },
    ticket: { type: "string", description: "the real ticket to act on -- required for DELETE_TICKET, PARTIAL_CLOSE, and MODIFY, pick one from OPEN POSITIONS/PENDING ORDERS below" },
    closeLots: { type: "number", description: "required for PARTIAL_CLOSE -- how many lots of the position to close" },
    newSl: { type: ["number", "null"], description: "optional for MODIFY -- the open position's new SL. A number sets it, null explicitly removes it, omit to leave it unchanged." },
    newTp: { type: ["number", "null"], description: "optional for MODIFY -- the open position's new TP. A number sets it, null explicitly removes it, omit to leave it unchanged." },
    pauseMinutes: { type: "number", description: "optional for PAUSE -- how long to pause, 1 to 5 minutes; defaults to 5 if omitted" },
    requestedNextSymbol: {
      type: "string",
      description: "optional -- request a SPECIFIC symbol for the NEXT cycle instead of round-robin order, with a real, genuine reason (e.g. related to a trade you took, or something you want to confirm once a candle closes)",
    },
    requestedNextReason: { type: "string", description: "the real reason for requestedNextSymbol -- required alongside it to mean anything" },
    setReminder: {
      type: "object",
      description:
        "optional on ANY decision -- a reminder to your future self, for something worth coming back to later than the next cycle (a candle close, a level not reached yet, a session opening, a trade to review once it has played out). It fires as a message to the trader and comes back to you here with your reason.",
      properties: {
        text: { type: "string", description: "what to do or check when it fires, written so it makes sense on its own later" },
        reason: { type: "string", description: "the idea or observation that made you set it -- required" },
        inMinutes: { type: "number", description: "minutes from now until it fires (1 to 43200)" },
        symbol: { type: "string", description: "optional symbol it is about" },
      },
      required: ["text", "reason", "inMinutes"],
    },
    deleteReminderIds: { type: "array", items: { type: "string" }, description: "optional on ANY decision -- ids of your reminders to delete: ones you have acted on, or that no longer matter" },
    actions: ACTIONS_SCHEMA,
  };
  // Real, confirmed bug fixed (user, live: the bot placed a trade at a literal 0% confidence --
  // "what's the point of placing the market then"). Root cause: `confidence` sat in `properties`
  // but was never in `required`, unlike lots/sl/tp above, so the model could (and did) omit it,
  // and the call site's `decision.confidence ?? 0` then silently treated "the model gave no real
  // confidence" as "the model is 0% confident", which auto-fires under the default
  // autoApproveBelowThreshold=true policy exactly like a real, deliberate low score would. Making
  // it required here is the primary fix (same precedent as the `lots` fix above); the call site
  // also independently hard-blocks a missing/invalid confidence as defense in depth, since a
  // model can still return a malformed/missing value despite the schema.
  const required = ["action", "reason", "confidence"];
  if (risk.lotMode !== "on") required.push("lots");
  const rrNote =
    `Your configured risk:reward floor is ${minRiskReward}:1 and it is a HARD GATE -- a trade whose target pays less than ${minRiskReward}x what its stop risks is refused before it reaches the broker, no matter how good the setup looks. ` +
    `Place the stop where the thesis is genuinely wrong and the target where price is genuinely likely to reach, then check the ratio clears ${minRiskReward}:1. If it doesn't, the ENTRY is in the wrong place -- SKIP or wait for a better one. Never stretch the target or tighten the stop just to pass this check.`;
  // Only the levels the model actually sets are offered. A FIXED stop/target is the trader's rule
  // and is applied in code (trade-levels.ts); offering the field anyway is how the model's own
  // number used to silently replace the trader's fixed 30 pips.
  if (risk.slMode !== "on") properties.sl = { type: "number", description: `Stop loss price${risk.slMode === "off" ? " (no fixed rule is set -- give one where the idea is proven wrong)" : ""}. ${rrNote}` };
  if (risk.slMode === "auto") required.push("sl");
  if (risk.tpMode !== "on") properties.tp = { type: "number", description: `Take profit price, placed at the broker. ${rrNote}` };
  if (risk.tpMode === "auto") required.push("tp");
  else if (risk.tpMode === "off") {
    properties.target = {
      type: "number",
      description: `Only when you give no tp: the price you expect this trade to reach. Not placed at the broker -- but every trade needs tp or target, because the risk:reward floor is checked against it. ${rrNote}`,
    };
  }
  return {
    name: DECISION_TOOL_NAME,
    description: "Submit your real trading decision for this one symbol, right now.",
    parameters: { type: "object", properties, required },
  };
}

export class InvalidTickDecisionError extends Error {
  constructor(raw: string) {
    super(`Autonomous tick got an unparseable decision -- expected one JSON object, got: ${raw.slice(0, 200)}`);
    this.name = "InvalidTickDecisionError";
  }
}

/** Real interrupt path (user, live: a real incoming chat message must be able to cut off an
 *  in-flight autonomous tick's model call, not just run alongside it unaware). Thrown by
 *  requestDecision() below when its provider.generate() call rejects because the caller's own
 *  turn-abort.ts controller (wired in by runAutonomousTradingCycle in telegram-bot-server.ts) was
 *  genuinely aborted -- distinct from InvalidTickDecisionError/a real provider failure, both of
 *  which stay real, unexpected errors. Caught at each real requestDecision() call site so the
 *  tick exits cleanly (no crash, no unhandled rejection) WITHOUT advancing the round-robin cursor
 *  -- advanceCursor is only ever called after a genuine decision came back, so an aborted tick
 *  naturally retries the same symbol next scheduled cycle, exactly the desired behavior. */
export class TickAbortedError extends Error {
  constructor() {
    super("Autonomous tick interrupted by a real user message");
    this.name = "TickAbortedError";
  }
}

function coerceDecision(obj: Record<string, unknown>): TickDecision {
  const action = String(obj.action ?? "SKIP").toUpperCase();
  if (!(DECISION_ACTIONS as readonly string[]).includes(action)) throw new InvalidTickDecisionError(JSON.stringify(obj));
  return {
    action: action as DecisionAction,
    symbol: typeof obj.symbol === "string" ? obj.symbol : undefined,
    entry: typeof obj.entry === "number" ? obj.entry : undefined,
    sl: typeof obj.sl === "number" ? obj.sl : undefined,
    tp: typeof obj.tp === "number" ? obj.tp : undefined,
    target: typeof obj.target === "number" ? obj.target : undefined,
    lots: typeof obj.lots === "number" ? obj.lots : undefined,
    confidence: typeof obj.confidence === "number" ? obj.confidence : undefined,
    reason: typeof obj.reason === "string" ? obj.reason : undefined,
    strategyTag: typeof obj.strategyTag === "string" ? obj.strategyTag : undefined,
    question: typeof obj.question === "string" ? obj.question : undefined,
    options: Array.isArray(obj.options) ? obj.options.map(String) : undefined,
    // "#1240932484" (seen live: MODIFY rejected as "ticket ##1240932484 isn't open") -> "1240932484".
    ticket: typeof obj.ticket === "string" || typeof obj.ticket === "number" ? String(obj.ticket).replace(/^\s*#+/, "").trim() || undefined : undefined,
    closeLots: typeof obj.closeLots === "number" ? obj.closeLots : undefined,
    pullbackScalp:
      obj.pullbackScalp && typeof obj.pullbackScalp === "object"
        ? {
            sl: typeof (obj.pullbackScalp as Record<string, unknown>).sl === "number" ? ((obj.pullbackScalp as Record<string, unknown>).sl as number) : undefined,
            tp2: typeof (obj.pullbackScalp as Record<string, unknown>).tp2 === "number" ? ((obj.pullbackScalp as Record<string, unknown>).tp2 as number) : undefined,
          }
        : undefined,
    pauseMinutes: typeof obj.pauseMinutes === "number" ? obj.pauseMinutes : undefined,
    // Real semantics (must match tradeModify/modifyOrder exactly): explicit null means "remove
    // this SL/TP", a real number means "set it", and genuinely absent/undefined -- including any
    // other unexpected type -- means "leave it unchanged". `"newSl" in obj` is what distinguishes
    // an explicit null from a key that was never sent at all.
    newSl: typeof obj.newSl === "number" ? obj.newSl : "newSl" in obj && obj.newSl === null ? null : undefined,
    newTp: typeof obj.newTp === "number" ? obj.newTp : "newTp" in obj && obj.newTp === null ? null : undefined,
    requestedNextSymbol: typeof obj.requestedNextSymbol === "string" && obj.requestedNextSymbol.length > 0 ? obj.requestedNextSymbol : undefined,
    requestedNextReason: typeof obj.requestedNextReason === "string" ? obj.requestedNextReason : undefined,
    script: typeof obj.script === "string" && obj.script.trim().length > 0 ? obj.script : undefined,
    scriptLanguage: obj.scriptLanguage === "bash" || obj.scriptLanguage === "node" ? obj.scriptLanguage : "python",
    setReminder: coerceReminder(obj.setReminder),
    deleteReminderIds: Array.isArray(obj.deleteReminderIds) ? obj.deleteReminderIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0) : undefined,
    actions: coerceTickActions(obj.actions),
  };
}

/** Applies a decision's optional reminder fields. Never fails the cycle: a bad reminder is logged
 *  and dropped, the trading decision still stands. */
export function applyReminderChanges(userId: string, symbol: string, decision: Pick<TickDecision, "setReminder" | "deleteReminderIds">): void {
  for (const id of decision.deleteReminderIds ?? []) {
    const removed = deleteReminder(userId, id);
    logTick(userId, removed ? `${symbol}: deleted reminder ${id} -- ${removed.text}` : `${symbol}: asked to delete reminder ${id}, which does not exist`);
  }
  if (decision.setReminder) {
    try {
      const r = createReminder(userId, { ...decision.setReminder, symbol: decision.setReminder.symbol ?? symbol, source: "autonomous" });
      logTick(userId, `${symbol}: set reminder ${r.id} for ${new Date(r.dueAt).toISOString()} -- ${r.text} (why: ${r.reason})`);
    } catch (err) {
      logTick(userId, `${symbol}: could not set reminder -- ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function coerceReminder(raw: unknown): TickDecision["setReminder"] {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const text = typeof r.text === "string" ? r.text.trim() : "";
  const reason = typeof r.reason === "string" ? r.reason.trim() : "";
  const inMinutes = typeof r.inMinutes === "number" ? r.inMinutes : Number(r.inMinutes);
  if (!text || !reason || !Number.isFinite(inMinutes)) return undefined;
  return { text, reason, inMinutes, symbol: typeof r.symbol === "string" && r.symbol.trim() ? r.symbol.trim() : undefined };
}

/** Text-JSON fallback for a provider that doesn't return a real tool call. */
function parseDecisionFromText(text: string): TickDecision {
  const match = text.match(/\{[\s\S]*\}/);
  const raw = match ? match[0] : text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidTickDecisionError(text);
  }
  return coerceDecision(parsed as Record<string, unknown>);
}

/**
 * Real risk-taker framing, the user's explicit words: there is no such thing as a perfect setup,
 * take any real opportunity that can bring profit, and when auto-approve is on a real decision
 * fires without hesitation. No correlation-check-before-sizing mandate, no candle/price staleness
 * gate, no multi-step checklist -- those are exactly the kind of secondary criteria that hand a
 * model an excuse to pass on a real setup, and this is a single decisive call, not a place for
 * a rule to hide behind.
 */
/** Real bug fixed (user, live: "it just only see the 4 prompts only"): this used to be a
 *  bare, ~14-line hand-written prompt, completely separate from the real SOUL/IDENTITY/SECURITY/
 *  trading/BOOTSTRAP prompt stack (system-prompt.ts's loadSystemPrompt, the same one normal chat
 *  uses) -- meaning every mission/precedence/risk-discipline rule, and critically the SMC/ICT-
 *  first analysis lens in trading.md, never reached a single live autonomous trade decision. Now
 *  the real prompt stack is the base, with only the tick-specific mechanics (which tool to call,
 *  what each action means) appended on top -- nothing about Dave's actual trading judgment lives
 *  in this file anymore, it all comes from the one real source of truth. */
function buildSystemPrompt(): string {
  return `${loadSystemPrompt()}

---

You are in an autonomous trading TICK right now, not a conversation -- there is no user to reply to, just one real decision to make.

You receive one symbol's full real multi-timeframe analysis below, plus this account's real current settings, and a real summary of what's already open -- including, per open position that has both a real SL and TP, a visual progress bar toward each. Decide right now: BUY, SELL, BUY_LIMIT, SELL_LIMIT, BUY_STOP, SELL_STOP, DELETE_TICKET, PARTIAL_CLOSE, MODIFY, PAUSE, CONSULT_JOURNAL, REQUEST_CANDLES, RUN_SCRIPT, SKIP, or ASK -- call the ${DECISION_TOOL_NAME} tool with your decision, always with your own honest confidence and reasoning.

BUY/SELL are market orders, right now. BUY_LIMIT/SELL_LIMIT/BUY_STOP/SELL_STOP are real pending orders at a specific entry you set. PREFER LIMIT ORDERS: put a BUY_LIMIT/SELL_LIMIT at the level where the spike starts (the sweep, the order block, the zone) with its stop and target, and let price come to you -- that is how you avoid a wrong entry. Use BUY/SELL only when price is at the ignition point right now. OPTIONAL with a BUY_LIMIT/SELL_LIMIT: a PULLBACK SCALP at market riding price into the limit (a BUY under a SELL_LIMIT, a SELL over a BUY_LIMIT): TP1 = the limit entry exactly (automatic), TP2 past the limit (the overshoot) but short of the limit's own SL, and an SL where the pullback idea is wrong -- include pullbackScalp {sl, tp2} only when there is a real pullback to ride. It is never compulsory: leave it out when many trades are already open or two more positions would pass max open trades, when free margin/leverage is already stretched, or when TP1 can't pay the risk:reward floor. A clean limit alone is fine.

THE SPIKE RULE (the trader's own): entries go on spike levels -- the price a spike launches from (the swept high/low, the order-block edge, the range boundary after compression, the level BOOM/CRASH keep firing from) -- never just "where price is". There is never a perfect level: pick the best one your analysis shows and TAKE it, with the stop tight behind it; unsure between two levels, take the better one or place limits on both. With no sniper setup, scalp: small, fast profits off the spikes. YOUR DEFAULT IS TO TRADE. A SKIP needs a concrete reason you can name (the stop can't fit, margin is gone, structure broke against you); "not perfect", "want more confirmation", "not fully sure" are not reasons -- the trader has told you plainly that you are too scared and they are begging you to place trades. Be aggressive and decisive.

SETUPS: when the right entry needs price to do something first (sweep the high THEN come back to the level; break the range THEN retest it), don't just walk away -- arm it with setup_create (steps in order, cancelIf for the move that kills the idea, the order with SL/TP). It runs on its own against the live price and places the order the moment the last step happens. Check setup_list first so you don't arm duplicates.

CLEAN SETUP = TAKE IT: bias clear + price at (or a limit on) a real key level + liquidity swept or right behind it + a trigger (CHoCH/rejection, or the level itself for a limit) -> trade, at your scale's size, no further conditions. "No ignition yet", "overbought", "deep premium", "R:R can't be met" (the TP is set at your exact R:R automatically) and "not perfect" are NOT reasons to skip. The only skip reasons: no key level within reach, structure broke against the idea on closed candles, the stop can't fit, a hard gate.

You are never idle. A SKIP is never empty: if there is no trade here right now, stage the next one -- a limit at the level your analysis supports, or a setReminder (with the idea as the reason) for the candle close or session the setup is waiting on. Say in your reason what you staged. A bare SKIP is only for a symbol with genuinely nothing forming.

You may ASK a single genuine question only for real, specific ambiguity you cannot resolve yourself. Prefer deciding over asking.

DELETE_TICKET cancels an existing pending order you no longer want -- use it with a real ticket from PENDING ORDERS below; you never close an open position (only its stop, its target or the trader does). PARTIAL_CLOSE is refused the same way. MODIFY adjusts SL and/or TP on an existing open position (needs ticket) without closing anything -- pass newSl/newTp as a number to set it, null to explicitly remove it, or omit either to leave it unchanged. PAUSE stops you from opening ANY new trade for a short while (1-5 minutes, your call) when you judge there's already enough real open exposure -- you can still ASK, DELETE_TICKET, PARTIAL_CLOSE, or MODIFY while paused, just not open something new.

CONSULT_JOURNAL asks Journal, your trade-review sidekick, for a second, honest opinion before you commit -- entirely optional, never required. Journal has its own access to trade history and analysis tools; it reviews and comments, it never places or modifies a trade itself. Use it when a setup is genuinely borderline and a second read would help, not as a default detour. After Journal answers, you'll be asked to decide again with its opinion in hand.

REQUEST_CANDLES gets you one fresh real batch of candle data for the symbol you're analyzing right now before you finalize your decision -- entirely optional, never required, available on any cycle, at most once. After the candles come back, you'll be asked to decide again with them in hand -- do not request candles a second time.

You can also do SEVERAL things in one scan with the optional "actions" list on the decision tool: move a winner to breakeven, tighten another trade's stop -- all together, alongside your main action -- and/or ask for several fresh reads at once (candles, volatility, momentum, zones... on any symbol/timeframe). Reads come back together and you decide once more with them. Use it when it genuinely saves a cycle, not as a routine step.

RUN_SCRIPT runs one real script (bash/python/node) and hands you its genuine output before you finalize -- entirely optional, never required, at most once per cycle. This symbol's full analysis suite is written into the sandbox as market.json, so your script reads real numbers rather than you eyeballing them. Reach for it ONLY when the decision genuinely hinges on something you cannot work out reliably in your head -- a risk:reward or position-size calculation you want exact, a spread or ratio across the timeframes below, a level derived from a real series. Do NOT use it as a routine step before every trade: it costs a real round trip on a live cycle, and nearly every decision here is already answerable from the suite in front of you. These symbols are synthetic pairs that exist only in this terminal and on no public API, so never have a script try to fetch their price from the internet -- everything you need is in market.json. After the output comes back you'll be asked to decide again -- do not run a second script.

If a SELF-AWARE ALERT appears below, one of your real open positions is genuinely close to hitting its SL -- REQUEST_CANDLES there fetches for that at-risk symbol instead. After the candles come back, act directly with MODIFY (tighten / move to breakeven), PARTIAL_CLOSE, or SKIP to hold it -- the stop is its invalidation, so no early fear-close (a close before the stop is held anyway). Do not be quick to close: the market often fakes out before the real move. Cut an open trade only when the reason for it is genuinely broken (name the evidence), never just because it is red or pulled back -- the stop is already where the idea is wrong.

You may also set requestedNextSymbol (with a real requestedNextReason) on ANY decision to ask that a specific symbol be analyzed next cycle instead of the mechanical round-robin order -- e.g. to follow up on a trade you just took, or to check back once a candle you're watching closes. Optional, never required.

REMINDERS: on ANY decision you may also set setReminder (text, reason, inMinutes, optional symbol) -- a note to your future self for something worth coming back to LATER than the next cycle: an H1 or H4 candle you want closed before committing, a level price hasn't reached yet, a session about to open, a trade to review once it has had time to play out. The reason is required: write the idea that made you set it, so it still makes sense when it fires. When it fires, the trader gets it as a message and phone notification, and it shows up under YOUR REMINDERS below as "fired" -- act on it then, and remove it with deleteReminderIds. Also delete any pending reminder that no longer matters. Set a reminder instead of skipping the same setup cycle after cycle while waiting for one thing; do not set one for something you would check next cycle anyway, and do not set a second reminder for something already pending.

sl/tp: apply automatically when the mode shown below is "on" -- you don't need to compute them, and the field won't even be offered to you. When "auto," you must compute a real sl/tp yourself from the analysis (structure, ATR, support/resistance) and the tool call requires it. A stop placed unreasonably close to price will be rejected -- size it to real, current volatility, not habit. When "off," don't include it.

lots: applied automatically when mode is "on." Otherwise include your own real sizing against the real account balance shown -- size to win, not timidly.`;
}

function buildTradeAdviceBlock(confidence: ReturnType<typeof getConfidenceSettings>): string {
  const autoNote = confidence.autoApproveBelowThreshold
    ? "Auto-approve is ON for below-threshold setups -- a real decision you make fires immediately, it does not wait on anyone. Take the opportunity."
    : `Auto-approve is OFF -- a decision below ${confidence.threshold}% confidence queues for the user's approval instead of firing immediately. That's expected, not a reason to hold back on a real read.`;
  return `You are a risk taker. Find a setup and take the opportunity -- a scalp or a sniper entry, or a well-placed limit order if you don't see an immediate one. ${autoNote}`;
}

const ENTRY_ACTIONS = new Set<string>(["BUY", "SELL", "BUY_LIMIT", "SELL_LIMIT", "BUY_STOP", "SELL_STOP"]);

interface CursorSymbolResult {
  symbol: string;
  usingFallback: boolean;
  /** This scan was started by an alert, not the rotation. `manage`: the pair has an open trade. */
  focus?: { reason: string; manage: boolean };
}

/** Resolves the real symbol for THIS tick from the round-robin cursor, skipping past any symbol
 *  that already carries an open position, or whose real market is genuinely closed right now
 *  (user, live: "whether market is closed that's for forex it shouldn't analyze that even set as
 *  fallback too") -- advancing without spending a decision call on either case, bounded so an
 *  all-closed/all-open list can't spin forever. */
function resolveCursorSymbol(userId: string, primary: string[], fallback: string[], openSymbols: Set<string>, groupIdFor: (symbol: string, usingFallback: boolean) => string | null, manageOnly = false, pendingSymbols: Set<string> = new Set()): CursorSymbolResult | null {
  // Real requested-next-symbol override (user, live: the model can note "analyze SYMBOL next,
  // because REASON" on any decision, and the round-robin honors that specific symbol on the VERY
  // NEXT cycle). Consumed exactly once regardless of outcome -- a stale/invalid request never
  // sticks around to be retried on a later cycle, it just falls back to normal round-robin THIS
  // cycle. Only ever honored if the requested symbol is still genuinely valid right now -- the
  // exact same real checks (still in the active group, market open, no existing position) a normal
  // round-robin symbol must pass, never skipped for an override. The round-robin cursor itself is
  // left untouched either way -- honoring an override is a one-off substitution, not a cursor jump.
  // A restart asked for from the app, Telegram, or by switching the scan on: first pair again.
  const restart = consumeScanRestart(userId);
  if (restart) {
    resetScanCursor(userId);
    const first = primary[0] ?? fallback[0];
    logTick(userId, `scan restarted from the first pair${first ? ` (${first})` : ""} -- requested by ${restart.source}`);
    if (first) publishActivity(userId, "loop", "scan_restart", { symbol: first, source: restart.source });
  }
  // An alert on a pair (a marked level hit, a self-aware alert on a trade) comes first -- even a
  // pair outside the active group, and even one with an open trade: that scan manages the trade.
  // Open trades AND pending orders are live -- seen live: a pending order's 10-minute recheck was
  // dropped as "already closed" because only positions were counted.
  const liveState = getLastKnownState(userId);
  const openTickets = new Set([...liveState.positions.map((p) => String(p.ticket)), ...(liveState.pendingOrders ?? []).map((o) => String(o.ticket))]);
  for (let f = takeAlertFocus(userId); f; f = takeAlertFocus(userId)) {
    // An alert about a trade that has closed since: nothing left to manage.
    const tickets = [...f.reason.matchAll(/#(\d{5,})/g)].map((m) => m[1]);
    if (tickets.length && !tickets.some((t) => openTickets.has(t))) {
      logTick(userId, `alert focus on ${f.symbol} dropped -- trade #${tickets[0]} is already closed`);
      continue;
    }
    const hours = isMarketOpenForSymbol(f.symbol, null, new Date());
    if (!hours.open) {
      logTick(userId, `alert focus on ${f.symbol} skipped -- ${hours.reason}`);
      continue;
    }
    const manage = openSymbols.has(f.symbol.toUpperCase());
    if (manageOnly && !manage && !pendingSymbols.has(f.symbol.toUpperCase())) {
      logTick(userId, `alert focus on ${f.symbol} skipped -- no room for a new trade right now`);
      continue;
    }
    logTick(userId, `alert focus -- analyzing ${f.symbol} now${manage ? " (open trade: manage it)" : ""}: ${f.reason.slice(0, 160)}`);
    return { symbol: f.symbol, usingFallback: false, focus: { reason: f.reason, manage } };
  }
  // Only here to manage open trades (at max trades / outside the session): no new pair.
  if (manageOnly) return null;
  const override = consumePendingSymbolOverride(userId);
  if (override) {
    const inPrimary = primary.find((s) => s.toUpperCase() === override.symbol.toUpperCase());
    const inFallback = fallback.find((s) => s.toUpperCase() === override.symbol.toUpperCase());
    const matched = inPrimary ?? inFallback;
    const usingFallback = !inPrimary && !!inFallback;
    if (!matched) {
      logTick(userId, `requested-next-symbol override skipped -- ${override.symbol} is no longer in the active group (requested reason: ${override.reason})`);
    } else {
      const hours = isMarketOpenForSymbol(matched, groupIdFor(matched, usingFallback), new Date());
      if (!hours.open) {
        logTick(userId, `requested-next-symbol override skipped -- ${matched} market closed (${hours.reason}) (requested reason: ${override.reason})`);
      } else if (openSymbols.has(matched.toUpperCase())) {
        logTick(userId, `requested-next-symbol override skipped -- ${matched} already has an open position (requested reason: ${override.reason})`);
      } else {
        logTick(userId, `requested-next-symbol override honored -- analyzing ${matched} next (requested reason: ${override.reason})`);
        return { symbol: matched, usingFallback };
      }
    }
  }

  const maxAttempts = primary.length + fallback.length;
  for (let i = 0; i < Math.max(1, maxAttempts); i++) {
    const { symbolCursor, scanningFallback } = getCursorPosition(userId);
    const active = scanningFallback ? fallback : primary;
    if (active.length === 0) {
      advanceCursor(userId, primary.length, fallback.length);
      continue;
    }
    const symbol = active[symbolCursor % active.length];
    // A pair the broker doesn't have, or that keeps returning nothing, is benched for a while
    // (symbol-availability.ts) -- skipped quietly instead of asked for again every cycle.
    // ...and a pair Dave's own strategy decided to leave alone (growth loop: avoid_symbol).
    if (isSymbolUnavailable(userId, symbol) || isAvoidedByStrategy(userId, symbol)) {
      advanceCursor(userId, primary.length, fallback.length);
      continue;
    }
    const hours = isMarketOpenForSymbol(symbol, groupIdFor(symbol, scanningFallback), new Date());
    if (!hours.open) {
      logTick(userId, `skipped ${symbol} -- ${hours.reason}`);
      advanceCursor(userId, primary.length, fallback.length);
      continue;
    }
    if (!openSymbols.has(symbol.toUpperCase())) return { symbol, usingFallback: scanningFallback };
    advanceCursor(userId, primary.length, fallback.length); // already open -- move past it, no decision spent
  }
  return null;
}

export interface RunTickDeps {
  userId: string;
  db: DaveDatabase;
  executor: TradeExecutor;
  provider: Provider;
  /** Real interrupt wiring (user, live, this session): the same turn-abort.ts controller signal
   *  the main chat path (runAgentTurn) already threads into AgentLoop.run() -- here threaded into
   *  the tick's own provider.generate() call so a real incoming user message can genuinely cancel
   *  an in-flight tick's network call, not just something nothing was ever listening to. Optional
   *  so every existing caller/test that doesn't wire it up keeps working unchanged. */
  signal?: AbortSignal;
  /** Part 3: real per-thought progress from the optional sequential-thinking pass (see
   *  sequential-thinking.ts), when getSequentialThinkingEnabled(userId) is on. The caller
   *  (telegram-bot-server.ts's runAutonomousTradingCycle) wires this to the SAME automatic
   *  `ThinkingIndicator` mechanism a real chat turn uses (tools.ts's activeIndicators) -- never a
   *  separate indicator. Optional; autonomous cycles are silent by default (per IDENTITY.md's
   *  "trade quietly"), so this is a
   *  no-op in the normal case where no chat indicator happens to be open. */
  onSequentialThinkingProgress?: (text: string) => void;
}

/** Real, plain trace of every tick -- there is no other way to see what the bot is actually
 *  doing between real trades than this stdout log (Railway's own log tail). Every early return
 *  used to be silent; now each one says exactly why, and the real chosen symbol/decision/reason
 *  gets logged too, right where it's decided. */
/** His last graded calls on this pair -- never allowed to break a scan. */
function safePastCalls(userId: string, symbol: string): string | null {
  try {
    return pastCallsBlock(userId, symbol);
  } catch {
    return null;
  }
}

/** The goal, the strategy card and what the brain has learned -- never allowed to break a scan. */
function safeGrowthBlock(userId: string): string | null {
  try {
    return growthContextBlock(userId, growthStatus(userId).score);
  } catch (err) {
    console.warn(`[autonomous-tick] ${userId}: growth block unavailable -- ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function logTick(userId: string, line: string): void {
  console.log(`[autonomous-tick] ${userId}: ${line}`);
  publishActivity(userId, "loop", "log", { text: line });
}

export async function runAutonomousTick(deps: RunTickDeps): Promise<TickOutcome> {
  const sideNotes: string[] = [];
  const outcome = await runAutonomousTickInner(deps, sideNotes);
  if (!sideNotes.length) return outcome;
  // Things Dave did alongside the main action (breakeven, a partial close...) always reach the
  // trader, even when the main action itself was a quiet SKIP.
  const extra = `⚡ Also this scan:\n${sideNotes.map((n) => `• ${n}`).join("\n")}`;
  return { ...outcome, notable: true, message: outcome.message ? `${outcome.message}\n\n${extra}` : extra };
}

async function runAutonomousTickInner(deps: RunTickDeps, sideNotes: string[]): Promise<TickOutcome> {
  const { userId, db, executor, provider, signal, onSequentialThinkingProgress } = deps;

  ensureGroupsUsable(userId);
  // An alert on an open trade gets its scan even when no new trade may be opened (outside the
  // session, at max trades, account gate) -- that scan only manages the trade.
  const openNow = new Set(getLastKnownState(userId).positions.map((p) => p.symbol.toUpperCase()));
  // (a pending order waiting on its pair counts: its recheck can cancel or move it, never add one)
  for (const o of getLastKnownState(userId).pendingOrders ?? []) openNow.add(o.symbol.toUpperCase());
  const tradeAlertWaiting = peekAlertFocus(userId).some((sym) => openNow.has(sym.toUpperCase()));
  let manageOnly = false;
  if (!isWithinSelectedSession(userId)) {
    if (!tradeAlertWaiting) {
      logTick(userId, "no trade -- outside the selected trading session window");
      return { action: "NONE", notable: false };
    }
    manageOnly = true;
  }

  const info = getActiveGroupInfo(userId);
  // Pairs Dave's own self-improvement decided to leave alone are never scanned (a pair the trader
  // pinned as the single active pair is still honoured).
  const avoided = info.activePairSymbol ? [] : info.effectiveSymbols.filter((sym) => isSymbolAvoided(userId, sym));
  if (avoided.length) console.log(`[autonomous-tick] ${userId}: leaving ${avoided.join(", ")} alone (self-improvement decided to avoid ${avoided.length === 1 ? "it" : "them"})`);
  const primarySymbols = info.effectiveSymbols.filter((sym) => !avoided.includes(sym));
  if (primarySymbols.length === 0) {
    logTick(userId, "no trade -- no active pair group or pair configured");
    return { action: "NONE", notable: false };
  }
  const fallbackSymbols = !info.activePairSymbol ? (info.fallbackGroup?.symbols ?? []).filter((sym) => !isSymbolAvoided(userId, sym)) : [];
  // Real bug fixed (test regression, step12): once a single-pair override is active, the active
  // GROUP's category is irrelevant to the overridden symbol -- pass null so isForexSymbol falls
  // through to pure shape-sniffing instead of trusting a group id that no longer describes what's
  // actually being scanned (e.g. an active "forex" group overridden to XAUUSD, a metal).
  const groupIdFor = (_symbol: string, usingFallback: boolean): string | null =>
    usingFallback ? (info.fallbackGroup?.id ?? null) : info.activePairSymbol ? null : (info.activeGroup?.id ?? null);

  const account = getLastKnownAccountSnapshot(userId);
  const { positions, pendingOrders } = getLastKnownState(userId);
  const risk = getRiskSettings(userId);
  // Read fresh every tick, exactly like every other setting here, so a change in /settings takes
  // effect on the very next cycle with no restart.
  const minRiskReward = getMinRiskReward(userId);
  const confidenceSettings = getConfidenceSettings(userId);
  // Real feature (user, live: "add a feature in the settings that the user can configure the
  // get all analysis... select among endpoints... and the timeframe, and a default button to
  // send all"). Defaults to every timeframe/endpoint (today's real behavior) until a user
  // deliberately narrows it.
  const analysisConfig = getAnalysisConfig(userId);
  const analysis = createEaAnalysisSource(userId);

  // Real gap fixed (user, live: "the have been placing a lot of trade recently because it
  // doesn't know the pending orders it just place and the active" -- `maxOpenTrades` was stored
  // but never actually read by any trade-placement code path). A hard, code-level ceiling, not
  // left to the model's own judgment -- checked before the expensive multi-timeframe analysis
  // fetch, so it also saves the EA round-trips.
  if (risk.maxOpenTrades !== undefined && positions.length >= risk.maxOpenTrades) {
    if (!tradeAlertWaiting) {
      logTick(userId, `no trade -- at max open trades (${positions.length}/${risk.maxOpenTrades})`);
      return { action: "NONE", notable: false };
    }
    manageOnly = true;
  }

  // Real pre-trade account-awareness gate (prompts/trading.md "Account awareness"): even when the
  // user hasn't set a maxOpenTrades ceiling, don't let the autonomous cycle keep opening positions
  // into an account that's already over-leveraged -- checked with whatever real snapshot the EA
  // has last reported, before the expensive multi-timeframe analysis fetch below.
  if (account) {
    const awareness = evaluateAccountAwareness(
      { balance: account.balance, freeMargin: account.freeMargin, leverage: account.leverage, openPositionsCount: positions.length },
      { maxOpenTrades: risk.maxOpenTrades }
    );
    if (!awareness.ok) {
      if (!tradeAlertWaiting) {
        logTick(userId, `no trade -- account awareness gate: ${awareness.reason}`);
        return { action: "NONE", notable: false };
      }
      manageOnly = true;
    }
  }

  // The AI is down (out of credit, dead key...): don't pull a whole analysis from MT5 only to fail
  // at the model call -- wait until the back-off runs out (ai-outage.ts).
  const outage = activeAiOutage(userId, Date.now(), currentAiSetup(db, userId));
  if (outage) {
    logTick(userId, `skipped -- ${outage.reason}; trying again in ${Math.max(1, Math.round((outage.retryAt - Date.now()) / 60_000))} min`);
    return { action: "NONE", notable: false };
  }

  const openSymbols = new Set(positions.map((p) => p.symbol.toUpperCase()));
  const picked = resolveCursorSymbol(userId, primarySymbols, fallbackSymbols, openSymbols, groupIdFor, manageOnly, new Set(pendingOrders.map((o) => o.symbol.toUpperCase())));
  if (!picked && manageOnly) {
    logTick(userId, "no trade -- no new trades allowed right now, and no alerted open trade to manage");
    return { action: "NONE", notable: false };
  }
  if (!picked) {
    logTick(userId, `no trade -- every symbol in the active group already has an open position or a closed market (${[...openSymbols].join(", ") || "none tracked"})`);
    return { action: "NONE", notable: false };
  }
  const { symbol } = picked;
  const activeTimeframes = analysisConfig.mode === "custom" && analysisConfig.timeframes.length > 0 ? analysisConfig.timeframes : ANALYSIS_TIMEFRAMES;
  logTick(userId, `picked ${symbol}${picked.usingFallback ? " (fallback group)" : ""} -- requesting full analysis across ${activeTimeframes.join("/")}...`);
  publishActivity(userId, "loop", "analysis", { symbol, timeframes: activeTimeframes, stage: "reading" });

  // Real gap fixed (user, live: doubted "all timeframes" was genuinely happening -- it wasn't.
  // The EA's own "all" endpoint (DaveEA.mq5's RunAnalysis/A_All) computes every sub-indicator
  // against ONLY the single timeframe it's given -- "get all timeframes in one call" isn't a
  // real capability on the EA side, so a single analysis.get("all", symbol, "H1") call was never
  // actually multi-timeframe, no matter what the context block claimed. This genuinely requests
  // "all" once per real timeframe and merges them, so multi-timeframe alignment (the sniper/
  // scalper mandate in trading.md) is real data the model actually receives, not a label on a
  // single H1 read.
  const suiteByTimeframe = await Promise.all(
    activeTimeframes.map((tf) =>
      analysis
        .get<Record<string, unknown>>("all", symbol, tf, { timeoutMs: 300_000 })
        .then((data) => ({ tf, data, error: undefined as string | undefined }))
        .catch((err) => ({ tf, data: null, error: err instanceof Error ? err.message : String(err) }))
    )
  );
  // One line for all the timeframes that failed, not one per timeframe.
  const failedTfs = suiteByTimeframe.filter((r) => r.error);
  if (failedTfs.length) logTick(userId, `analysis for ${symbol} failed on ${failedTfs.map((r) => r.tf).join("/")}: ${failedTfs[0].error}`);
  const suite: Record<string, unknown> = {};
  for (const { tf, data } of suiteByTimeframe) suite[tf] = data ? filterSuiteToConfig(data, analysisConfig) : { error: "unavailable this cycle" };

  // Real gap fixed (user, live: doubted `get_all_analysis` is genuinely fetching the FULL suite
  // across every configured timeframe, not something silently partial/stubbed). Built from the
  // real, unfiltered `suiteByTimeframe` results above -- what actually came back from the EA per
  // timeframe -- not from `suite` (which is already narrowed by the user's own analysisConfig
  // selection, and would understate what was genuinely fetched). A timeframe whose fetch failed
  // above (data === null) is real-honestly left OUT of both timeframesReceived and
  // endpointKeysPerTimeframe -- this must reflect what actually happened this cycle, not what was
  // merely requested.
  const rawMergedSuite: Record<string, unknown> = {};
  for (const { tf, data } of suiteByTimeframe) if (data) rawMergedSuite[tf] = data;
  const timeframesReceived = suiteByTimeframe.filter((r) => r.data).map((r) => r.tf);
  const endpointKeysPerTimeframe: Record<string, string[]> = {};
  for (const tf of timeframesReceived) {
    const d = rawMergedSuite[tf];
    endpointKeysPerTimeframe[tf] = d && typeof d === "object" ? Object.keys(d as Record<string, unknown>) : [];
  }
  const totalPayloadBytes = Buffer.byteLength(JSON.stringify(rawMergedSuite), "utf8");
  const analysisDebugFetchedAt = Date.now();
  console.log(
    "[analysis-debug] " +
      JSON.stringify({ symbol, timeframesRequested: activeTimeframes, timeframesReceived, endpointKeysPerTimeframe, totalPayloadBytes, fetchedAt: analysisDebugFetchedAt })
  );
  recordAnalysisFetch(userId, {
    symbol,
    timeframesRequested: [...activeTimeframes],
    timeframesReceived,
    endpointKeysPerTimeframe,
    totalPayloadBytes,
    fetchedAt: analysisDebugFetchedAt,
    rawSuite: rawMergedSuite,
  });

  // Real waste fixed (live logs: FLAMES had no history loaded in MT5, every timeframe errored,
  // and every cycle still paid for a full model call only to hear "no data, SKIP"). With nothing
  // received for this symbol and no open position that might need managing, there is nothing for
  // the model to decide -- record the skip honestly and move on.
  if (timeframesReceived.length === 0) {
    // Real bug fixed (the trader, from the logs: XPTUSD asked for every cycle, every timeframe
    // failing, for hours). This path never moved the round-robin on, so the SAME dead pair was
    // picked again and again. Now it moves on, and after NO_DATA_STRIKES misses the pair is
    // benched and the trader is told once.
    const firstError = suiteByTimeframe.find((r) => r.error)?.error ?? "no data";
    const strike = recordNoData(userId, symbol, String(firstError).slice(0, 160));
    if (positions.length === 0 || strike.benched) {
      const reason = `no analysis data from the EA for ${symbol} on any timeframe`;
      logTick(userId, `${symbol}: ${reason} -- skipped without a model call${strike.benched ? ` (benched for ${BENCH_HOURS}h)` : ""}`);
      recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason });
      advanceCursor(userId, primarySymbols.length, fallbackSymbols.length);
      if (strike.benched) {
        const text = `⚠️ Leaving ${symbol} alone for ${BENCH_HOURS}h -- MT5 gave no data for it on any timeframe ${strike.strikes} scans in a row (${String(firstError).slice(0, 140)}). If you want it traded, add it to Market Watch in MT5 or check your broker offers it.`;
        publishActivity(userId, "background", "alert", { text });
        return { action: "NONE", symbol, notable: true, message: text };
      }
      return { action: "NONE", notable: false };
    }
  } else {
    recordHasData(userId, symbol);
  }

  const primaryTfResult = suiteByTimeframe.find((r) => r.tf === "H1")?.data ?? suiteByTimeframe.find((r) => r.data)?.data;
  const priceInfo = (primaryTfResult as { price?: { bid?: number; ask?: number; close?: number } } | null)?.price;
  const referencePrice = priceInfo?.bid ?? priceInfo?.ask ?? priceInfo?.close ?? 0;
  const atr = (primaryTfResult as { volatility?: { atr?: number } } | null)?.volatility?.atr ?? 0;

  // Real gaps fixed (user: SMC/ICT audit -- "HTF bias same as HTF & LTF", "a single real number
  // multi-timeframe confluence score", "no basket/correlation risk check", "no spread-widening-
  // around-news detection"). All four computed from data already genuinely fetched this cycle --
  // no new EA call, no MQL5 change. See mtf-confluence.ts for the real reasoning per computation.
  const mtfAlignmentLine = computeMtfAlignment(suiteByTimeframe);
  const mtfConfluenceLine = computeMtfConfluenceScore(suiteByTimeframe);
  const basketRiskLine = computeBasketCurrencyRisk(positions, () => null);
  const spreadNewsRiskLine = computeSpreadNewsRisk(primaryTfResult);

  // Real feature (user, live: wants visual TP/SL progress bars per open position, plus a
  // self-aware alert when a trade is genuinely close to hitting its SL). Only computed for a
  // position that HAS a real sl, tp, AND currentPrice -- never fabricated for one missing any of
  // the three, per the real EaPosition shape (ea-webhook.ts). slProgress is the same real
  // distance-travelled fraction buildProgressBar renders as a bar, kept as a raw number here too
  // so the SELF-AWARE ALERT threshold check below is a real numeric comparison, not a re-parse of
  // the rendered string.
  interface PositionProgress {
    ticket: string;
    symbol: string;
    tpBar: string;
    slBar: string;
    slProgress: number;
  }
  const positionsProgress = new Map<string, PositionProgress>();
  for (const p of positions) {
    if (p.sl === undefined || p.tp === undefined || p.currentPrice === undefined) continue;
    // Directional, like the trade monitor's (trade-monitor-store.ts): only a move AGAINST the trade
    // counts. The old version measured distance from entry either way, so a trade in profit was
    // reported "52% toward its SL" (seen live on a winning STORM_500 sell, which confused the model
    // into asking the trader for details instead of moving the stop to breakeven).
    const inLoss = p.pnl !== undefined ? p.pnl < 0 : true;
    const slProgress = inLoss ? (directionalSlProgress({ openPrice: p.openPrice, sl: p.sl }, p.currentPrice) ?? 0) : 0;
    positionsProgress.set(p.ticket, {
      ticket: p.ticket,
      symbol: p.symbol,
      tpBar: buildProgressBar(p.openPrice, p.currentPrice, p.tp),
      slBar: buildProgressBar(p.openPrice, p.currentPrice, p.sl),
      slProgress,
    });
  }

  const positionsSummary = positions.length
    ? positions
        .map((p) => {
          const owner = ownerTag(p);
          const base = `${p.symbol} ${p.type.toUpperCase()} ${p.lots} lots @ ${p.openPrice}${p.sl !== undefined && p.sl !== 0 ? ` SL ${p.sl}` : " NO SL"}${p.tp !== undefined && p.tp !== 0 ? ` TP ${p.tp}` : ""} pnl=${p.pnl ?? "?"} ticket ${p.ticket}${owner ? ` [${owner}]` : ""}`;
          const progress = positionsProgress.get(p.ticket);
          return progress ? `${base} | Progress to TP: ${progress.tpBar} | Progress to SL: ${progress.slBar}` : base;
        })
        .join("; ")
    : "none";
  const pendingSummary = pendingOrders.length ? pendingOrders.map((p) => `${p.symbol} ${p.type.toUpperCase()} ${p.lots} lots @ ${p.price} ticket ${p.ticket}${ownerTag(p) ? ` [${ownerTag(p)}]` : ""}`).join("; ") : "none";

  // Real self-aware SL-danger alert (user's own exact stated bar, now 50%+): ANY open position
  // account-wide at/beyond SL_DANGER_THRESHOLD, not just the current round-robin symbol's own
  // position -- picks the single worst (highest SL-progress) one if more than one qualifies, and
  // pulls its REAL original placement reason from the real trade journal by ticket (never a
  // placeholder), matching exactly how getTradeLifecycle/journal-agent.ts already read a stored
  // trade's reason by ticket elsewhere in this codebase.
  // One thing per scan (the trader: "it should send individually"): only THIS pair's trade -- a
  // trade on another pair gets its own alert scan from the monitor.
  const dangerPosition = [...positionsProgress.values()].filter((pp) => pp.slProgress >= SL_DANGER_THRESHOLD && pp.symbol.toUpperCase() === symbol.toUpperCase()).sort((a, b) => b.slProgress - a.slProgress)[0] ?? null;
  let selfAwareAlertLine: string | null = null;
  if (dangerPosition) {
    const lifecycle = getTradeLifecycle(db, userId, { ticket: dangerPosition.ticket });
    const originalReason = lifecycle[0]?.reasoning?.length ? lifecycle[0].reasoning.join(" ") : (lifecycle[0]?.narrative ?? "no original placement reason recorded in the trade journal");
    logTick(
      userId,
      `SELF-AWARE ALERT: ticket #${dangerPosition.ticket} (${dangerPosition.symbol}) is at ${Math.round(dangerPosition.slProgress * 100)}% progress toward its SL`
    );
    selfAwareAlertLine = `SELF-AWARE ALERT: Ticket #${dangerPosition.ticket} (${dangerPosition.symbol}) is at ${Math.round(dangerPosition.slProgress * 100)}% real progress toward its SL -- genuinely close to being stopped out. Original real reason when this trade was placed: "${originalReason}". You may REQUEST_CANDLES for ${dangerPosition.symbol} for one fresh look before deciding. You never close it -- the stop is its invalidation; hold, or MODIFY to protect it if it's in profit.`;
  }

  const selfPause = getSelfPause(userId);

  // Real gap fixed (the trader: "the bot shouldn't compromise when a skill is added by reviewing
  // other endpoints"): the <active_strategy_skill> block built in live-context.ts was only ever
  // reaching the interactive chat path -- this autonomous tick builds its own contextLines and
  // never called it, so a skill marked active had zero effect on real autonomous decisions,
  // silently defeating strict-adherence the moment /start_trading was running. Same real lookup,
  // same "no active skill -> no block, trading.md's own judgment governs" behavior as the
  // interactive path -- this never blocks or slows a trade, it only shapes which endpoints/
  // timeframes the decision below is allowed to lean on.
  let activeStrategySkillLine: string | null = null;
  const activeSkillId = getActiveStrategySkillId(userId);
  if (activeSkillId) {
    const activeSkill = getSkill(userId, activeSkillId);
    if (activeSkill) {
      activeStrategySkillLine = [
        `ACTIVE STRATEGY SKILL: "${activeSkill.name}" -- follow this explicitly for this decision. Use only the timeframes, endpoints, and signals this strategy actually calls for -- do NOT supplement it with other tools, timeframes, or indicators "just to be safe". That is not extra diligence, it is silently trading a different strategy than the one the user activated. This does not change whether you trade -- it only changes what you're allowed to base the decision on.`,
        activeSkill.description ? `Summary: ${activeSkill.description}` : null,
        `Full instructions: ${activeSkill.content}`,
        // Real, live failure this exists to surface (see analysis-config.ts's own account): this
        // account's active skill required a D1 bias read "before any entry" while the analysis
        // scope no longer fetched D1, so step one of the only strategy in force could never
        // complete. 41 consecutive cycles stood down with no error anywhere -- indistinguishable
        // from a cautious bot finding nothing. The instruction above ("use ONLY what the strategy
        // calls for, do NOT supplement") is what makes this fatal rather than merely awkward, so
        // when the scope genuinely cannot satisfy the skill the model is told plainly, instead of
        // being left to conclude the setup is incomplete forever.
        scopeWarningFor(userId, activeSkill.content),
      ].filter((l): l is string => l !== null).join("\n");
    }
  }

  // Real gaps fixed, all three the autonomous half of bugs already fixed on the chat path. The
  // tick builds its own context from scratch and calls the model with toolChoice FORCED to the
  // single decision tool, so it cannot call a tool to fetch any of this -- if it isn't in these
  // lines, it does not exist for an autonomous trade decision:
  //  - the clock (the trader: "the bot doesn't know time"). Chat turns get one; every autonomous
  //    decision was being made with no idea what time or session it was.
  //  - what Dave has learned and written down. Knowledge was unreachable here by construction,
  //    so a lesson saved after a bad trade could never affect the next autonomous one -- which is
  //    the entire point of saving it.
  //  - standing instructions in memory ("don't trade X", "never during the open"), which the chat
  //    path has honoured since memory was wired in but a cycle never saw.
  const clockLine = buildClockLine();
  const tickMemory = safeTickMemory(userId);
  const tickKnowledge = safeTickKnowledgeIndex(userId);

  // The APA structure read for this pair, from raw candles (apa-structure.ts): H4 / H1 / M15.
  const apaLines: string[] = [];
  await Promise.all(
    (["H4", "H1", "M15"] as const).map(async (tf) => {
      try {
        const { bars } = parseCandles(await analysis.get<unknown>("candles", symbol, tf, { timeoutMs: 20_000 }));
        const line = describeApa(tf, bars);
        if (line) apaLines.push(line);
      } catch {
        // No candles for this timeframe right now -- the rest of the read still stands.
      }
    })
  );
  apaLines.sort((a, b) => ["H4", "H1", "M15"].indexOf(a.slice(0, a.indexOf(":"))) - ["H4", "H1", "M15"].indexOf(b.slice(0, b.indexOf(":"))));
  const contextLines = [
    clockLine,
    tickMemory ? `WHAT YOU REMEMBER (already known -- treat as standing instructions):\n${tickMemory}` : null,
    tickKnowledge
      ? `WHAT YOU HAVE LEARNED AND SAVED (your own past conclusions -- guidance, not rules: your settings and the trader's instructions outrank them. Apply any whose "use when" fits this symbol right now. If one of them is the reason you keep skipping, say so with ASK rather than skipping silently cycle after cycle):\n${tickKnowledge}`
      : null,
    picked.focus
      ? `ALERT -- THIS SCAN WAS STARTED BY IT (act on it now, this is why you're looking at ${symbol}):\n${picked.focus.reason}\n` +
        `THIS PAIR RIGHT NOW: price ${JSON.stringify(priceInfo ?? {})}; open trades on ${symbol}: ${
          positions.filter((p) => p.symbol.toUpperCase() === symbol.toUpperCase()).map((p) => `${p.type.toUpperCase()} ${p.lots} @ ${p.openPrice}${p.sl !== undefined ? ` SL ${p.sl}` : ""}${p.tp !== undefined ? ` TP ${p.tp}` : ""} pnl=${p.pnl ?? "?"} #${p.ticket}`).join("; ") || "none"
        }; pending orders on ${symbol}: ${
          pendingOrders.filter((o) => o.symbol.toUpperCase() === symbol.toUpperCase()).map((o) => `${o.type} @ ${o.price} #${o.ticket}`).join("; ") || "none"
        }. The full multi-timeframe analysis for ${symbol} is below.\n` +
        (picked.focus.manage
          ? `You have an open trade on ${symbol} (see OPEN POSITIONS). Decide what to do with THAT trade: hold (say why the idea still holds), move the stop to breakeven, or tighten it -- via actions/MODIFY. You NEVER close or part-close a trade: only its stop, its target or the trader closes it (the code refuses a close). The market deceives. No new entry on ${symbol} in this scan.`
          : pendingOrders.some((o) => o.symbol.toUpperCase() === symbol.toUpperCase())
            ? `You have a pending order on ${symbol} (above). Recheck it on this fresh analysis: keep it (say in one line why the level and idea still hold), cancel it with DELETE_TICKET, or cancel and place it where price will really come. Never stack a second pending order on the same idea.`
            : `If the level/setup is live, take the trade now; if price isn't there yet, arm a limit on the level. SKIP only for a reason on your skip list (no level in reach, structure broke against it, stop can't fit, a hard gate).`)
      : null,
    `SYMBOL: ${symbol}`,
    `PRICE: ${JSON.stringify(priceInfo ?? {})}`,
    `ACCOUNT: balance=${account?.balance ?? "unknown"} equity=${account?.equity ?? "unknown"} freeMargin=${account?.freeMargin ?? "unknown"} leverage=${account?.leverage ?? "unknown"}`,
    `SL_MODE: ${risk.slMode}${risk.slMode === "on" ? ` (fixed ${risk.slValue} pips)` : ""} | TP_MODE: ${risk.tpMode}${risk.tpMode === "on" ? ` (fixed ${risk.tpValue} pips)` : ""} | LOT_MODE: ${risk.lotMode}${risk.lotMode === "on" ? ` (fixed ${risk.lotValue})` : ""}`,
    levelsGuidance(risk, minRiskReward),
    `CONFIDENCE THRESHOLD: ${confidenceSettings.threshold}%`,
    // The setting the tick used to enforce silently without ever showing it -- see
    // buildDecisionTool's header for why its absence read as "it ignores my setting".
    risk.tpMode === "on"
      ? `MINIMUM RISK:REWARD: ${minRiskReward}:1 -- a HARD GATE. Any BUY/SELL/pending order whose target pays less than ${minRiskReward}x its stop risk is REFUSED before it reaches the broker. Size your stop and target to genuine levels and check the ratio clears ${minRiskReward}:1; if it can't, the entry is wrong -- SKIP it.`
      : `RISK:REWARD: exactly 1:${minRiskReward} -- the take profit is placed AUTOMATICALLY at ${minRiskReward}x the stop's distance from the entry. You choose the entry and a stop at a real level; if the ${minRiskReward}x target from that stop isn't realistic, the entry is wrong -- SKIP it.`,
    buildTradeAdviceBlock(confidenceSettings),
    // Real gap fixed (user, live: "it doesn't know the pending orders it just place and the
    // active" / wants position info shown "when it knows that the trade it opened is already
    // plenty"). Every cycle, regardless of which symbol was picked, sees the real current
    // exposure -- this is what actually gives the model position awareness, not just the hard
    // maxOpenTrades ceiling above.
    `OPEN POSITIONS (${positions.length}${risk.maxOpenTrades !== undefined ? `/${risk.maxOpenTrades} max` : ""}): ${positionsSummary}`,
    `PENDING ORDERS: ${pendingSummary}`,
    ...(apaLines.length ? [`APA STRUCTURE for ${symbol} (computed from the candles -- THIS is what your APA strategy reads; the other indicator endpoints are background only):\n${apaLines.map((l) => `- ${l}`).join("\n")}`] : []),
    selfPause
      ? `SELF-PAUSE ACTIVE until ${new Date(selfPause.pausedUntil).toISOString()} (${selfPause.reason}) -- you may still ASK, DELETE_TICKET, or PARTIAL_CLOSE, but you may NOT open a new BUY/SELL/pending order until this expires.`
      : null,
    !isAutonomousExecutionEnabled(userId)
      ? `AUTONOMOUS TRADING IS STOPPED (the user ran /stop_trading) -- you may still analyze, ASK, DELETE_TICKET, or PARTIAL_CLOSE, but a normal new trade will NOT be auto-placed. Only if your real confidence is ${SNIPER_TIER_CONFIDENCE}%+ (genuinely sniper-tier) will a BUY/SELL/pending decision be sent to the user as an approve/decline ask -- anything below that, just SKIP.`
      : null,
    // Real bug fixed (user, live: "confirm it's sending all the complete endpoints... and
    // timeframe too"): this used to hard-cap the merged suite at 6000 characters -- with 44
    // endpoints across 6 real timeframes the real JSON is far larger, so most of what
    // ANALYSIS_TIMEFRAMES actually requested was silently cut before the model ever saw it.
    // Raised well past any real single-request's actual size instead of an arbitrary small slice.
    `FULL ANALYSIS SUITE, genuinely one real "all" call per timeframe (${activeTimeframes.join(", ")}), merged below -- check for real alignment or conflict across them, not just one: ${JSON.stringify(suite).slice(0, 60_000)}`,
    mtfAlignmentLine,
    mtfConfluenceLine,
    basketRiskLine,
    spreadNewsRiskLine,
    // One thing per scan: only this pair's own history, reminders and alerts -- never a log of
    // other pairs' decisions or alerts (each of those gets a scan of its own).
    formatRecentDecisions(userId, symbol),
    buildTickRemindersLine(userId, Date.now(), symbol),
    selfAwareAlertLine,
    selfAwareFeedBlock(userId, undefined, Date.now(), { symbol, exclude: picked.focus?.reason }),
    safeGrowthBlock(userId),
    safePastCalls(userId, symbol),
    activeStrategySkillLine,
  ].filter((line): line is string => line !== null);

  const tool = buildDecisionTool(risk, minRiskReward);

  async function requestDecision(lines: string[]): Promise<TickDecision | null> {
    let genResult;
    try {
      publishActivity(userId, "loop", "analysis", { symbol, stage: "deciding" });
      genResult = await provider.generate(
        { messages: [{ role: "system", content: buildSystemPrompt() }, { role: "user", content: lines.join("\n") }], tools: [tool], toolChoice: { name: DECISION_TOOL_NAME } },
        60_000,
        signal
      );
    } catch (err) {
      // Real cancel path: a real incoming user message called abortTurn(userId) (turn-abort.ts),
      // which aborted THIS tick's controller too (runAutonomousTradingCycle in
      // telegram-bot-server.ts wires it in exactly like runAgentTurn already does for the main
      // chat) -- the underlying provider call genuinely rejects because of that, not because of a
      // real upstream failure. Checked via signal.aborted (the same real idiom AgentLoop.run()
      // already uses) rather than trying to pattern-match the rejection itself, since different
      // providers/runtimes surface an aborted fetch differently.
      if (signal?.aborted) {
        logTick(userId, `${symbol}: model call interrupted by a real user message -- moving on, next cycle continues to the next symbol`);
        throw new TickAbortedError();
      }
      logTick(userId, `model call for ${symbol} failed: ${err instanceof Error ? err.message : String(err)}`);
      const o = markAiOutage(userId, err, Date.now(), currentAiSetup(db, userId));
      if (o.isNew) {
        publishActivity(userId, "background", "alert", {
          text: `⚠️ Trading scans are paused: ${o.reason}. I'll stop asking MT5 for analysis and try again on my own every few minutes -- top up or fix the key and I carry on.`,
        });
      }
      throw err;
    }
    const downFor = clearAiOutage(userId);
    if (downFor !== undefined) {
      publishActivity(userId, "background", "alert", { text: `✅ The AI is answering again after ${Math.max(1, Math.round(downFor / 60_000))} min -- trading scans are back on.` });
    }
    try {
      const toolCall = genResult.toolCalls?.find((c) => c.name === DECISION_TOOL_NAME);
      return toolCall ? coerceDecision(toolCall.arguments) : parseDecisionFromText(genResult.text);
    } catch {
      logTick(userId, `${symbol}: unparseable model response -- raw text: ${genResult.text.slice(0, 300)}`);
      return null;
    }
  }

  // Part 3: sequential thinking, opt-in, scoped ONLY to this one final trade decision -- never
  // for CONSULT_JOURNAL/REQUEST_CANDLES follow-up re-decisions below (that would multiply an
  // already-bounded extra round trip into an unbounded one), and never for general chat. Real
  // cost/latency tradeoff (see sequential-thinking.ts's own header comment): up to
  // MAX_SEQUENTIAL_THOUGHTS extra real model calls before the decision itself, so this only runs
  // when the user has explicitly turned it on (getSequentialThinkingEnabled, OFF by default).
  // Scans started by an alert / reminder / marked level act fast on the one thing that fired --
  // no thinking pass unless the trader switched it on for them (thinking-stages.ts).
  const skipThinkingForAlert = !!picked.focus && !getThinkOnAlertScans(userId);
  if (skipThinkingForAlert && getSequentialThinkingEnabled(userId)) logTick(userId, `${symbol}: alert scan -- straight to the decision (thinking on alert scans is off)`);
  if (getSequentialThinkingEnabled(userId) && !skipThinkingForAlert) {
    logTick(userId, `${symbol}: sequential thinking (${getSequentialThinkingEffort(userId)} effort) -- running a bounded reasoning pass before deciding`);
    const effort = getSequentialThinkingEffort(userId);
    const { thoughts, summary } = await runSequentialThinking({
      provider,
      systemPrompt: buildSystemPrompt(),
      contextLines,
      effort,
      // The trader's own steps -- every enabled one is mandatory.
      stages: getEnabledThinkingStages(userId).map((st) => ({ id: st.id, help: st.help })),
      onProgress: (text: string) => {
        publishActivity(userId, "loop", "thought", { symbol, text }, { agent: "thinking" });
        onSequentialThinkingProgress?.(text);
      },
    });
    if (summary) {
      logTick(userId, `${symbol}: sequential thinking (${effort}) produced ${thoughts.length} real thought(s)`);
      contextLines.push(summary);
    }
  }

  let decision: TickDecision | null;
  try {
    decision = await requestDecision(contextLines);
  } catch (err) {
    if (err instanceof TickAbortedError) {
      // Real, live bug fixed (user: "the slide from one pair to another pair isn't working").
      // Root cause: an interrupted tick used to return here WITHOUT ever calling advanceCursor --
      // every real user message aborts the in-flight tick (Feature 1, turn-abort.ts's abortTurn),
      // so any user who chats with Dave at all trapped the round-robin on whichever symbol
      // happened to be mid-analysis at that moment, forever. The original design (and the user's
      // own request) was clear: an interrupted tick's slot is simply skipped and the NEXT cycle
      // continues to the next symbol, nothing stuck. Cursor now genuinely advances here too, same
      // as every other SKIP/no-decision outcome below.
      recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: "interrupted by a real user message" });
      advanceCursor(userId, primarySymbols.length, fallbackSymbols.length);
      return { action: "NONE", notable: false };
    }
    throw err;
  }
  if (!decision) {
    recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: "unparseable model response" });
    advanceCursor(userId, primarySymbols.length, fallbackSymbols.length);
    return { action: "NONE", notable: false };
  }

  // Real feature (user, live: "it can ask journal what do you think... not compulsory"). Bounded
  // to at most one extra round trip per tick -- never a loop: if CONSULT_JOURNAL comes back
  // again after Journal already answered, that's treated as a SKIP rather than consulted twice.
  if (decision.action === "CONSULT_JOURNAL") {
    logTick(userId, `${symbol}: consulting Journal before deciding -- ${decision.reason ?? "wants a second read"}`);
    const journalResult = await consultJournal(
      { userId, db, provider },
      `Dave is considering a setup on ${symbol} and wants your honest opinion before committing. His own reasoning so far: ${decision.reason ?? "none given"}`,
      contextLines
    );
    publishActivity(userId, "loop", "journal", { symbol, opinion: journalResult.opinion }, { agent: "journal" });
    recordTickDecision(userId, { ts: Date.now(), symbol, action: "CONSULT_JOURNAL", reason: decision.reason ?? "" });
    let decisionAfterConsult: TickDecision | null;
    try {
      decisionAfterConsult = await requestDecision([...contextLines, `JOURNAL'S OPINION (you asked for this -- decide now, do not consult again): ${journalResult.opinion}`]);
    } catch (err) {
      if (err instanceof TickAbortedError) {
        // Same real cursor-advance fix as the initial requestDecision's abort branch above -- an
        // interrupt mid-CONSULT_JOURNAL must not trap the round-robin on this symbol either.
        recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: "interrupted by a real user message" });
        advanceCursor(userId, primarySymbols.length, fallbackSymbols.length);
        return { action: "NONE", notable: false };
      }
      throw err;
    }
    if (!decisionAfterConsult || decisionAfterConsult.action === "CONSULT_JOURNAL") {
      logTick(userId, `${symbol}: no real decision after consulting Journal -- treating as SKIP`);
      recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: "no real decision after consulting Journal" });
      advanceCursor(userId, primarySymbols.length, fallbackSymbols.length);
      return { action: "NONE", notable: false };
    }
    decision = decisionAfterConsult;
  }

  // Real bounded auxiliary tool call (user's own explicit self-aware SL-danger spec, generalized
  // this session -- user, live: the model should have a general way to ask for one more real piece
  // of data before finalizing an ORDINARY decision too, not just during an SL-danger alert): the
  // EXACT same one-extra-round-trip shape as CONSULT_JOURNAL above -- reuses the real get_candles
  // endpoint via `analysis.get("candles", ...)` (the same requestAnalysis("candles", ...) call
  // EA_ANALYSIS_TOOLS's own get_candles tool makes, see dave-ea-bridge/src/tools.ts), never a new
  // tool, never a loop. Fetches for the at-risk symbol when a real SELF-AWARE ALERT is active
  // (unchanged behavior), otherwise for the symbol this cycle is already analyzing -- available on
  // ANY tick now, still bounded to exactly one extra round trip: a repeat REQUEST_CANDLES on the
  // second call is rejected below, exactly mirroring CONSULT_JOURNAL's own repeat-guard.
  if (decision.action === "REQUEST_CANDLES") {
    const targetSymbol = dangerPosition?.symbol ?? symbol;
    const forNote = dangerPosition ? ` for at-risk ticket #${dangerPosition.ticket}` : "";
    let candlesLine: string;
    logTick(userId, `${symbol}: fetching fresh candles for ${targetSymbol}${forNote} before re-deciding -- ${decision.reason ?? "wants current price action"}`);
    try {
      const candles = await analysis.get<Record<string, unknown>>("candles", targetSymbol, "M5", { timeoutMs: 60_000 });
      candlesLine = `FRESH CANDLES for ${targetSymbol}${dangerPosition ? ` (you requested this for the at-risk ticket #${dangerPosition.ticket})` : " (you requested this before finalizing your decision)"}: ${JSON.stringify(candles).slice(0, 10_000)}`;
    } catch (err) {
      candlesLine = `REQUEST_CANDLES for ${targetSymbol} failed: ${err instanceof Error ? err.message : String(err)} -- decide with what you already have.`;
    }
    recordTickDecision(userId, { ts: Date.now(), symbol, action: "REQUEST_CANDLES", reason: decision.reason ?? "" });
    let decisionAfterCandles: TickDecision | null;
    try {
      decisionAfterCandles = await requestDecision([...contextLines, `${candlesLine} (decide now -- do not request candles again)`]);
    } catch (err) {
      if (err instanceof TickAbortedError) {
        // Same real cursor-advance fix as above -- an interrupt mid-REQUEST_CANDLES must not trap
        // the round-robin on this symbol either.
        recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: "interrupted by a real user message" });
        advanceCursor(userId, primarySymbols.length, fallbackSymbols.length);
        return { action: "NONE", notable: false };
      }
      throw err;
    }
    if (!decisionAfterCandles || decisionAfterCandles.action === "REQUEST_CANDLES") {
      logTick(userId, `${symbol}: no real decision after REQUEST_CANDLES -- treating as SKIP`);
      recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: "no real decision after REQUEST_CANDLES" });
      advanceCursor(userId, primarySymbols.length, fallbackSymbols.length);
      return { action: "NONE", notable: false };
    }
    decision = decisionAfterCandles;
  }

  // RUN_SCRIPT: real compute before a real trade decision (the trader, asking whether run_script
  // reaches "mode 2, the autonomous loop aspect" -- it did not, and could not: this path is a
  // single forced call with exactly ONE tool, not an agent loop, so putting run_script in the core
  // tool list did nothing here). Deliberately built as another bounded ACTION on the same one
  // decision tool, exactly like REQUEST_CANDLES above, rather than by reopening this path into a
  // multi-tool agentic loop: a trading decision that could call tools freely would have unbounded
  // latency on every symbol of every cycle. Strictly one extra round trip, and it costs nothing at
  // all on the cycles where the model doesn't ask for it.
  if (decision.action === "RUN_SCRIPT") {
    let scriptLine: string;
    if (!decision.script) {
      scriptLine = "RUN_SCRIPT was chosen but no script was provided -- decide now with what you already have.";
      logTick(userId, `${symbol}: RUN_SCRIPT with no script -- re-deciding without it`);
    } else {
      logTick(userId, `${symbol}: running a ${decision.scriptLanguage ?? "python"} script before deciding -- ${decision.reason ?? "wants a real calculation"}`);
      try {
        const run = await runScriptInE2B(db, userId, {
          script: decision.script,
          language: decision.scriptLanguage ?? "python",
          // The suite is already fetched and in context -- handing the script the SAME data as a
          // real file costs no extra EA round trip, and is the only way it can reach a synthetic
          // pair at all (nothing on the public internet carries these symbols).
          filesIn: [{ path: "market.json", content: JSON.stringify({ symbol, timeframes: activeTimeframes, suite }) }],
          timeoutMs: TICK_SCRIPT_TIMEOUT_MS,
        });
        const files = run.filesOut.filter((f) => f.encoding === "utf8").map((f) => `${f.path}: ${f.content}`).join("\n");
        scriptLine =
          `YOUR SCRIPT'S REAL OUTPUT (exit code ${run.exitCode}, you requested this before finalizing your decision):\n` +
          `stdout:\n${run.stdout.slice(0, 10_000) || "(empty)"}` +
          (run.stderr ? `\nstderr:\n${run.stderr.slice(0, 3_000)}` : "") +
          (files ? `\nfiles:\n${files.slice(0, 5_000)}` : "") +
          (run.exitCode !== 0 ? `\n\nThe script FAILED. Do not read a result into output it did not produce -- decide with your analysis instead.` : "");
      } catch (err) {
        // A missing E2B key, a quota, a sandbox failure -- all genuinely possible on a live
        // account, and none of them may stop a trading cycle. Reported honestly and the tick
        // carries on with the analysis it already has.
        scriptLine = `RUN_SCRIPT failed: ${err instanceof Error ? err.message : String(err)} -- decide with what you already have, and do not try to run another script this cycle.`;
        logTick(userId, `${symbol}: RUN_SCRIPT failed -- ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    recordTickDecision(userId, { ts: Date.now(), symbol, action: "RUN_SCRIPT", reason: decision.reason ?? "" });
    let decisionAfterScript: TickDecision | null;
    try {
      decisionAfterScript = await requestDecision([...contextLines, `${scriptLine} (decide now -- do not run another script)`]);
    } catch (err) {
      if (err instanceof TickAbortedError) {
        // Same cursor-advance fix as the branches above -- an interrupt mid-RUN_SCRIPT must not
        // trap the round-robin on this symbol.
        recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: "interrupted by a real user message" });
        advanceCursor(userId, primarySymbols.length, fallbackSymbols.length);
        return { action: "NONE", notable: false };
      }
      throw err;
    }
    if (!decisionAfterScript || decisionAfterScript.action === "RUN_SCRIPT") {
      logTick(userId, `${symbol}: no real decision after RUN_SCRIPT -- treating as SKIP`);
      recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: "no real decision after RUN_SCRIPT" });
      advanceCursor(userId, primarySymbols.length, fallbackSymbols.length);
      return { action: "NONE", notable: false };
    }
    decision = decisionAfterScript;
  }

  // Several things at once (mode 2): trade-management items run together right away; GET items
  // are all fetched in parallel and Dave decides once more with every result in hand.
  const runSideActions = async (d: TickDecision) => {
    const mgmt = (d.actions ?? []).filter((a) => !isDataAction(a));
    if (!mgmt.length) return;
    const fresh = getLastKnownState(userId);
    const results = await runManagementActions(executor, mgmt, fresh.positions, fresh.pendingOrders.map((o) => String(o.ticket)));
    for (const r of results) {
      logTick(userId, `${symbol}: action ${r.ok ? "done" : "not done"} -- ${r.text}`);
      publishActivity(userId, "loop", "action", { symbol, type: r.action.type, ok: r.ok, text: r.text });
      if (r.ok) sideNotes.push(r.text);
    }
    recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: `side actions: ${results.map((r) => r.text).join("; ")}`.slice(0, 400) });
  };
  if (decision.actions?.some(isDataAction)) {
    const gets = decision.actions.filter(isDataAction);
    await runSideActions(decision);
    logTick(userId, `${symbol}: fetching ${gets.length} reads at once (${gets.map((g) => `${g.endpoint}${g.symbol ? ` ${g.symbol}` : ""}${g.timeframe ? ` ${g.timeframe}` : ""}`).join(", ")}) -- ${decision.reason ?? "wants fresh data"}`);
    const gathered = await gatherData(analysis, gets, symbol);
    let decisionAfterGather: TickDecision | null;
    try {
      decisionAfterGather = await requestDecision([
        ...contextLines,
        `DATA YOU ASKED FOR (${gathered.fetched} fetched, ${gathered.failed} failed, all at once -- decide now; any GET items this time are ignored; management items you already ran are done, don't repeat them):`,
        ...gathered.lines,
      ]);
    } catch (err) {
      if (err instanceof TickAbortedError) {
        recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: "interrupted by a real user message" });
        advanceCursor(userId, primarySymbols.length, fallbackSymbols.length);
        return { action: "NONE", notable: false };
      }
      throw err;
    }
    if (!decisionAfterGather || (MANAGEMENT_AUX_ACTIONS as readonly string[]).includes(decisionAfterGather.action)) {
      logTick(userId, `${symbol}: no real decision after gathering data -- treating as SKIP`);
      recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: "no real decision after gathering data" });
      advanceCursor(userId, primarySymbols.length, fallbackSymbols.length);
      return { action: "NONE", notable: false };
    }
    decision = { ...decisionAfterGather, actions: decisionAfterGather.actions?.filter((a) => !isDataAction(a)) };
  }
  await runSideActions(decision);

  logTick(userId, `${symbol}: model decided ${decision.action}${decision.confidence !== undefined ? ` (confidence ${decision.confidence}%)` : ""} -- ${decision.reason ?? decision.question ?? "no reason given"}`);
  // A scan started to manage an open trade never stacks a second entry on the same pair.
  // Nor does a scan that only got through to manage (at max trades / outside the session).
  if (manageOnly && ENTRY_ACTIONS.has(decision.action)) {
    logTick(userId, `${symbol}: alert scan with no room for a new trade -- the ${decision.action} is not placed`);
    decision = { ...decision, action: "SKIP", reason: `(new entry not placed -- no room for a new trade right now) ${decision.reason ?? ""}` };
  }
  if (picked.focus?.manage && ENTRY_ACTIONS.has(decision.action) && (decision.symbol ?? symbol).toUpperCase() === symbol.toUpperCase()) {
    logTick(userId, `${symbol}: alert scan -- a new ${decision.action} on a pair with an open trade is not placed; managing the open trade only`);
    decision = { ...decision, action: "SKIP", reason: `(new entry not placed -- this scan manages the open ${symbol} trade) ${decision.reason ?? ""}` };
  }

  // Real requested-next-symbol override -- can accompany ANY decision (BUY/SELL/SKIP/etc, not a
  // separate action), persisted right after the real decision is recorded so resolveCursorSymbol
  // picks it up on the VERY NEXT cycle. Overwrites any previous still-pending override.
  if (decision.requestedNextSymbol) {
    const overrideReason = decision.requestedNextReason ?? "no reason given";
    logTick(userId, `${symbol}: requesting ${decision.requestedNextSymbol} for the next cycle -- ${overrideReason}`);
    setPendingSymbolOverride(userId, decision.requestedNextSymbol, overrideReason);
  }

  applyReminderChanges(userId, symbol, decision);

  // Written down to be graded against what price does next (decision-grades.ts) -- skips included.
  try {
    recordDecisionForGrading(userId, { symbol: decision.symbol ?? symbol, action: decision.action, reason: decision.reason ?? "", confidence: decision.confidence });
  } catch (err) {
    console.warn(`[autonomous-tick] ${userId}: could not record the call for grading -- ${err instanceof Error ? err.message : String(err)}`);
  }

  // The cursor always advances after a real decision, regardless of outcome -- this is what
  // keeps the loop moving through the whole group instead of getting stuck on one symbol. An
  // alert scan was an extra look, not the rotation's turn: the rotation stays where it was.
  if (!picked.focus) advanceCursor(userId, primarySymbols.length, fallbackSymbols.length);

  if (decision.action === "ASK") {
    if (!decision.question) return { action: "NONE", notable: false };
    // A question about data the scan already had (seen live: "what is the entry price for ticket
    // #... so I can set its stop to breakeven?") never reaches the trader.
    if (asksForShownTradeData(decision.question) && positions.length > 0) {
      logTick(userId, `${symbol}: dropped a question about data already in the scan -- "${decision.question.slice(0, 160)}"`);
      recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: "asked for open-trade data that was already in the scan (entry/SL/TP are listed under OPEN POSITIONS)" });
      return { action: "NONE", notable: false };
    }
    // Real bug avoided: the shared PendingQuestion mechanism (ask-user.ts) is designed for the
    // main chat's AgentLoop pause/resume -- a typed reply resumes it by finding the matching
    // tool-call id in THAT conversation's history. A tick-originated question has no such
    // history entry to resume, so setting the same blocking record here would deadlock every
    // future cycle (the top-of-cycle getPendingQuestion gate) with no way for the user's reply
    // to ever clear it. Sent as a real message instead, soft-tracked via the rolling recent-
    // decisions context (so the model sees its own unanswered question next cycle and doesn't
    // just repeat it) -- matching the reference bot's own soft, timeout-bound ASK, not a hard
    // block.
    recordTickDecision(userId, { ts: Date.now(), symbol, action: "ASK", reason: decision.question });
    return { action: "ASK", symbol, notable: true, message: decision.options?.length ? `${decision.question}\n\nOptions: ${decision.options.join(" / ")}` : decision.question };
  }

  if (decision.action === "SKIP") {
    const reason = decision.reason ?? "no real setup this cycle";
    recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason });
    const skipCount = recordSkipForHunt(userId, symbol);
    if (skipCount < HUNT_THRESHOLD || info.activePairSymbol === null) return { action: "NONE", notable: false };
    // Real hunt-mode broaden, ported from the reference bot's threshold-gated hunt: only fires
    // when a real single-pair focus is set and keeps skipping -- with no focus set, round-robin
    // already covers the whole group over time, nothing further to broaden into.
    const hunt = await huntForSetup(userId, analysis, "H1", { excludeSymbols: [symbol] });
    if (!hunt.bestSetup) return { action: "NONE", notable: false };
    clearHuntState(userId);
    return {
      action: "NONE",
      notable: true,
      huntModeActivated: true,
      message: `🔍 Hunt Mode Active — your focused pair (${symbol}) had nothing clean after ${skipCount} cycles. Best candidate found scanning the group: ${hunt.bestSetup.symbol} — confluence ${hunt.bestSetup.score}, ${hunt.bestSetup.direction}.`,
    };
  }

  // Real gap fixed (user, live: "add to it... a tool to delete the existing trade"). Look up
  // whether the given ticket is a pending order or an open position to pick the right real
  // operation -- never guess when it's neither.
  if (decision.action === "DELETE_TICKET") {
    const reason = decision.reason ?? "";
    if (!decision.ticket) {
      logTick(userId, `${symbol}: DELETE_TICKET rejected -- no ticket given`);
      recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: "DELETE_TICKET needs a ticket" });
      return { action: "NONE", notable: false };
    }
    const isPendingTicket = pendingOrders.some((p) => p.ticket === decision.ticket);
    const isOpenTicket = positions.some((p) => p.ticket === decision.ticket);
    if (!isPendingTicket && !isOpenTicket) {
      logTick(userId, `${symbol}: DELETE_TICKET rejected -- ticket #${decision.ticket} isn't a real open position or pending order`);
      recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: `DELETE_TICKET given an unknown ticket #${decision.ticket}` });
      return { action: "NONE", notable: false };
    }
    if (!isPendingTicket) {
      // Hold to the plan: no fear exits before the stop (hold-to-plan.ts).
      const pos = positions.find((p) => p.ticket === decision.ticket)!;
      const hold = holdOrClose(pos);
      if (!hold.close) {
        const protectedNote = hold.inProfit ? ` -- ${await protectInstead(executor, pos).catch((e) => `couldn't protect it: ${e instanceof Error ? e.message : String(e)}`)}` : "";
        logTick(userId, `${symbol}: close not done -- ${hold.why}${protectedNote}`);
        recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: `held #${decision.ticket} to its plan (${hold.inProfit ? "in profit, protected" : "stop not hit"}) instead of closing: ${reason}` });
        return { action: "NONE", notable: false };
      }
    }
    if (isPendingTicket) await deletePendingOrder(executor, decision.ticket);
    else await fullClose(executor, decision.ticket);
    recordTickDecision(userId, { ts: Date.now(), symbol, action: "DELETE_TICKET", reason });
    return {
      action: "DELETE_TICKET",
      symbol,
      notable: true,
      message: `🗑 Ticket #${decision.ticket} ${isPendingTicket ? "pending order deleted" : "closed"}\n💡 ${summarizeReason(reason || "no reason given")}`,
    };
  }

  if (decision.action === "PARTIAL_CLOSE") {
    const reason = decision.reason ?? "";
    if (!decision.ticket || !decision.closeLots) {
      logTick(userId, `${symbol}: PARTIAL_CLOSE rejected -- needs both a ticket and closeLots`);
      recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: "PARTIAL_CLOSE needs both a ticket and closeLots" });
      return { action: "NONE", notable: false };
    }
    // Dave never cuts a trade, not even part of it (hold-to-plan.ts): a winner is protected instead.
    const pos = positions.find((p) => p.ticket === decision.ticket);
    if (!pos) {
      logTick(userId, `${symbol}: PARTIAL_CLOSE rejected -- ticket #${decision.ticket} isn't open`);
      return { action: "NONE", notable: false };
    }
    const hold = holdOrClose(pos);
    if (!hold.close) {
      logTick(userId, `${symbol}: partial close not done -- ${hold.why}`);
      recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: `held #${decision.ticket} whole (losing -- the stop decides): ${reason}` });
      return { action: "NONE", notable: false };
    }
    const closeResult = await partialClose(executor, decision.ticket, decision.closeLots);
    recordTickDecision(userId, { ts: Date.now(), symbol, action: "PARTIAL_CLOSE", reason });
    return { action: "PARTIAL_CLOSE", symbol, notable: true, message: `✂️ Banked ${decision.closeLots} lots in profit on ticket ${decision.ticket} (${closeResult.remainingLots} lots remain)\n💡 ${summarizeReason(reason || "no reason given")}` };
  }

  // Real MODIFY action (user, live: adjust SL/TP on an existing open position without closing
  // it). Reuses the exact same isOpenTicket-style check PARTIAL_CLOSE already uses against the
  // real `positions` snapshot -- never reimplemented, so it works for any real open ticket
  // regardless of which symbol the round-robin cursor is currently on, exactly like
  // DELETE_TICKET/PARTIAL_CLOSE already do. newSl/newTp being explicitly `null` vs. genuinely
  // absent/undefined are kept distinct all the way through from coerceDecision -- null means
  // "remove this SL/TP", undefined means "leave it unchanged" -- matching tradeModify's/
  // modifyOrder's own real semantics exactly (see trade-execute.ts / ea-trade-executor.ts).
  if (decision.action === "MODIFY") {
    const reason = decision.reason ?? "";
    if (!decision.ticket) {
      logTick(userId, `${symbol}: MODIFY rejected -- no ticket given`);
      recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: "MODIFY needs a ticket" });
      return { action: "NONE", notable: false };
    }
    const openPosition = positions.find((p) => p.ticket === decision.ticket);
    if (!openPosition) {
      logTick(userId, `${symbol}: MODIFY rejected -- ticket #${decision.ticket} isn't a real open position (closed, or never existed)`);
      recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: `MODIFY given an unknown ticket #${decision.ticket}` });
      return { action: "NONE", notable: false };
    }
    if (decision.newSl === undefined && decision.newTp === undefined) {
      logTick(userId, `${symbol}: MODIFY rejected -- ticket #${decision.ticket} given neither newSl nor newTp`);
      recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: "MODIFY needs at least one of newSl/newTp" });
      return { action: "NONE", notable: false };
    }
    // Real old values captured from the live snapshot fetched THIS tick, before the call --
    // never guessed or reconstructed from the model's own claim, so the notification reflects
    // what the position's SL/TP genuinely were.
    const oldSl = openPosition.sl;
    const oldTp = openPosition.tp;
    await tradeModify(executor, decision.ticket, { sl: decision.newSl, tp: decision.newTp });
    recordTickDecision(userId, { ts: Date.now(), symbol, action: "MODIFY", reason });
    const slLine = decision.newSl !== undefined ? `SL ${oldSl ?? "none"} → ${decision.newSl === null ? "none" : decision.newSl}` : null;
    const tpLine = decision.newTp !== undefined ? `TP ${oldTp ?? "none"} → ${decision.newTp === null ? "none" : decision.newTp}` : null;
    return {
      action: "MODIFY",
      symbol,
      notable: true,
      message: `✏️ Ticket #${decision.ticket} modified -- ${[slLine, tpLine].filter(Boolean).join(", ")}\n💡 ${summarizeReason(reason || "no reason given")}`,
    };
  }

  if (decision.action === "PAUSE") {
    const reason = decision.reason ?? "judged enough open exposure for now";
    if (!getSelfPauseEnabled(userId)) {
      logTick(userId, `${symbol}: PAUSE requested but self-pause is disabled in settings -- ignored`);
      recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: "PAUSE requested but self-pause is disabled" });
      return { action: "NONE", notable: false };
    }
    // Real bug fixed (user, live: "what the hell is this" -- a redundant PAUSE decision while
    // already paused was re-extending the pause AND sending a fresh "Self-pausing" message every
    // single time). The model already sees SELF-PAUSE ACTIVE in its own context; a repeat PAUSE
    // decision is logged and silently absorbed, not re-announced or re-extended.
    const existingPause = getSelfPause(userId);
    if (existingPause) {
      logTick(userId, `${symbol}: PAUSE requested but self-pause is already active until ${new Date(existingPause.pausedUntil).toISOString()} -- not re-extending or re-announcing`);
      recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: "self-pause already active, redundant PAUSE absorbed" });
      return { action: "NONE", notable: false };
    }
    const state = setSelfPause(userId, decision.pauseMinutes ?? MAX_SELF_PAUSE_MINUTES, reason);
    const minutesLeft = Math.round((state.pausedUntil - Date.now()) / 60_000);
    recordTickDecision(userId, { ts: Date.now(), symbol, action: "PAUSE", reason });
    // Shown in the app's Live tab as a countdown ("Dave paused himself -- 4m left").
    publishActivity(userId, "loop", "self_pause", { until: state.pausedUntil, minutes: minutesLeft, reason, symbol });
    return { action: "PAUSE", symbol, notable: true, message: `⏸ Self-pausing for ${minutesLeft}m\n💡 ${summarizeReason(reason)}` };
  }

  // Real bug fixed (the trader, from the live trade logs: "the risk reward stuff"). The model often
  // works out good levels in its reasoning ("alternative SL 213,963 -> 2.92R, clears the floor")
  // but submits the OLD numbers in the decision fields -- or flips the stop to the wrong side of a
  // SELL -- and the whole setup was thrown away at the final check. Now the refusal goes back to
  // it ONCE, with the exact reason, so it can fix the levels it already found. Still a hard gate:
  // the final assessRiskRewardForUser check below is unchanged and nothing weaker gets through.
  const levelsFor = (d: TickDecision): TradeLevels =>
    resolveTradeLevels({ action: d.action as LevelAction, decision: d, risk, price: priceInfo, pip: derivePipSize(priceInfo), minRiskReward });
  let levels: TradeLevels | null = null;
  if ((TRADE_ACTIONS as readonly string[]).includes(decision.action)) {
    levels = levelsFor(decision);
    if (levels.problem && !levels.fatal) {
      logTick(userId, `${symbol}: ${decision.action} levels refused (${levels.problem}) -- sending it back once to fix them`);
      let repaired: TickDecision | null = null;
      try {
        repaired = await requestDecision([
          ...contextLines,
          `YOUR ${decision.action} (entry ${levels.entry || decision.entry || "market"}, SL ${levels.sl ?? "none"}, ${risk.tpMode === "off" ? `target ${levels.rrTarget ?? "none"}` : `TP ${levels.tp ?? "none"}`}) WAS REFUSED BEFORE REACHING THE BROKER: ${levels.problem} ` +
            `These are the exact numbers the order would use (fixed settings applied, market orders measured from the live price). ` +
            `If your reasoning already found better levels, submit the SAME trade again with numbers that genuinely work. If no honest levels clear it, SKIP. ` +
            `This is your only retry -- do not request candles, scripts or Journal now.`,
        ]);
      } catch (err) {
        if (err instanceof TickAbortedError) {
          recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: "interrupted by a real user message" });
          advanceCursor(userId, primarySymbols.length, fallbackSymbols.length);
          return { action: "NONE", notable: false };
        }
        throw err;
      }
      if (repaired && (TRADE_ACTIONS as readonly string[]).includes(repaired.action)) {
        Object.assign(decision, { ...repaired, confidence: repaired.confidence ?? decision.confidence, reason: repaired.reason ?? decision.reason });
        levels = levelsFor(decision);
        logTick(userId, `${symbol}: corrected to ${decision.action} entry ${levels.entry} SL ${levels.sl ?? "none"} target ${levels.rrTarget ?? "none"}${levels.ratio !== undefined ? ` (${levels.ratio}:1)` : ""}${levels.problem ? ` -- still refused: ${levels.problem}` : ""}`);
      } else {
        logTick(userId, `${symbol}: no corrected levels -- ${repaired?.action ?? "no answer"}; skipping`);
        decision.action = "SKIP";
      }
    }
    if (levels.problem && (TRADE_ACTIONS as readonly string[]).includes(decision.action)) {
      logTick(userId, `${symbol}: ${decision.action} rejected -- ${levels.problem}`);
      recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: `bad risk structure: ${levels.problem}` });
      advanceCursor(userId, primarySymbols.length, fallbackSymbols.length);
      return {
        action: "NONE",
        symbol,
        notable: true,
        message: `⚠️ Skipped ${symbol} ${decision.action} -- ${levels.problem}${levels.fatal ? "" : "\n\nNo trade: even after one correction, there were no honest levels that clear it."}`,
      };
    }
  }
  if (!(TRADE_ACTIONS as readonly string[]).includes(decision.action)) {
    recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: "its levels were refused and no corrected trade came back" });
    advanceCursor(userId, primarySymbols.length, fallbackSymbols.length);
    return { action: "NONE", notable: false };
  }

  // A real trade action from here.
  const action = decision.action as TradeAction;

  // Real gap fixed (user, live: wants the bot able to self-pause for up to 5 minutes when it
  // judges exposure is already high). The context line above tells the model about an active
  // pause, but a prose instruction alone isn't enough -- same lesson already applied elsewhere in
  // this file (e.g. the SL-auto rejection) -- so this is enforced in code: a real trade action
  // decided during an active self-pause is discarded here, never reaches order placement.
  if (selfPause) {
    logTick(userId, `${symbol}: ${action} rejected -- self-paused until ${new Date(selfPause.pausedUntil).toISOString()} (${selfPause.reason})`);
    recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: `self-paused, new trades blocked until ${new Date(selfPause.pausedUntil).toISOString()}` });
    return { action: "NONE", notable: false };
  }

  const orderType = ACTION_TO_ORDER_TYPE[action];
  const isPending = orderType !== "buy" && orderType !== "sell";
  if (isPending && decision.entry === undefined) {
    logTick(userId, `${symbol}: ${action} rejected -- needs an entry price and none was given`);
    recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: `${action} needs an entry price and none was given` });
    return { action: "NONE", notable: false };
  }

  // Real gap fixed (user, live: "the bot doesn't consider the sl in instance the there is a
  // solution... it usually put a sl that will kill a trade in instance"). Reject-only, sized to
  // real current volatility, not a fixed pip number -- never widens or otherwise changes the
  // SL/entry/direction/TP the model chose, just discards this cycle's decision back to a SKIP so
  // it can recompute on retry, exactly like the existing "SL mode is auto but didn't compute one"
  // rejection below.
  // The resolved levels (trade-levels.ts): fixed settings applied, market orders from the live price.
  let lv = levels ?? levelsFor(decision);
  // "Too tight" is measured from where the stop is triggered: the bid for a buy, the ask for a sell
  // (a pending order from its entry). The ratio is measured from where the trade gets in.
  const noiseRef = isPending ? lv.entry : exitPrice(action as LevelAction, priceInfo);
  if (lv.sl !== undefined && atr > 0 && isSlTooTight(noiseRef, lv.sl, atr)) {
    logTick(userId, `${symbol}: ${action} rejected -- SL ${lv.sl} is too tight relative to current ATR ${atr} (real price noise would likely stop this out immediately)`);
    recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: "SL too tight relative to current volatility" });
    return { action: "NONE", notable: false };
  }

  // Real gap fixed (user, live: /stop_trading not reliably stopping new trades. Root cause: the
  // top-of-cycle isTradingHalted/isAutonomousExecutionEnabled check happens once, before the
  // multi-minute analysis + model call above -- an in-flight cycle had nothing re-checking that
  // gate before firing. This is that final check, right before the order actually goes out.
  const stoppedMidFlight = isTradingHalted(userId) || !isAutonomousExecutionEnabled(userId);

  const order: OrderRequest = {
    symbol,
    type: orderType,
    lots: risk.lotMode === "on" && risk.lotValue !== undefined ? risk.lotValue : (decision.lots ?? 0),
    // A market order has no price of its own -- it fills at the live price.
    price: isPending ? decision.entry : undefined,
    // Real, live fix (user: the old `Dave ${confidence}% ${reason}`.slice(0, 40) comment crammed
    // as much of the real reasoning text as fit into 40 chars -- garbled/cut off mid-word or
    // mid-sentence on the MT5 side). Short and structured instead: confidence + a short
    // strategy/setup tag, nothing else -- the real, full reasoning goes out in full via the
    // Telegram push notification below, never here. `strategyTag` is optional on the schema (not
    // every action needs it), so a genuinely conservative fallback ("setup") keeps the comment
    // well-formed even if the model omits it; 28 chars is comfortably inside MT5's real
    // broker-enforced comment limit.
    comment: `Dave:${decision.confidence ?? "?"}% ${decision.strategyTag ?? "setup"}`.slice(0, 28).trimEnd(),
    // Real gap fixed (user, live: wants the SAME full reasoning that reaches Telegram to also
    // reach MT5 itself as a real push notification, not just the short `comment` above). The EA
    // truncates this to fit SendNotification's real ~255-char push limit and sends it in full via
    // SendMail -- see ea/DaveEA.mq5's "open" handler / NotifyTradeEvent.
    pushMessage: decision.reason,
  };
  if (order.lots <= 0) {
    logTick(userId, `${symbol}: ${action} rejected -- no valid lot size (lot mode=${risk.lotMode}, model gave lots=${decision.lots ?? "none"})`);
    recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: "no valid lot size" });
    return { action: "NONE", notable: false };
  }

  // Real bug fixed (the trader: "find bugs in my code"). This was a hardcoded `const pip = 0.0001`
  // driving BOTH the fixed-pip SL and the fixed-pip TP below. That is only right for 4-digit forex
  // and is catastrophically wrong for this trader's entire watchlist -- synthetic indices priced in
  // the hundreds of thousands, where a 40-pip TP resolved to 0.004 away from entry (i.e. AT the
  // entry price, closing instantly for nothing minus spread) and a 15-pip SL resolved to 0.0015,
  // which the ATR check below would reject on every single trade. Derived per symbol from the EA's
  // own numbers instead -- see pip-size.ts. undefined means it genuinely could not be established,
  // and the fixed-pip branches below refuse rather than fall back to a number that would be wrong
  // by orders of magnitude.
  const decisionAction = action === "BUY" || action === "BUY_LIMIT" || action === "BUY_STOP" ? "BUY" : "SELL";
  // Stop and target exactly as resolved above -- the numbers the risk:reward check already passed.
  order.sl = lv.sl;
  order.tp = lv.tp;

  // Real fix (general, applies regardless of two-step mode -- both this and Flo touch the same
  // pre-execute code path): a pending order (BUY_LIMIT/SELL_LIMIT/BUY_STOP/SELL_STOP) is only
  // still meaningful as a PENDING order if the real live price hasn't already reached the entry
  // level the model set it at. The model's decision was computed against the analysis suite
  // fetched at the top of this tick -- by the time execution reaches here, the real live price
  // (referencePrice, the same one already used for SL-sanity/fixed-SL calculations above) may
  // have already moved past that entry, meaning the exact move the pending order was meant to
  // catch (a dip for a BUY_LIMIT/breakdown for a SELL_STOP, a rally for a SELL_LIMIT/breakout for
  // a BUY_STOP) has already happened. Genuine MT5 order-placement rules require a pending order's
  // entry to sit on the correct side of the current live price at all -- a BUY_LIMIT needs
  // entry < price (still waiting for a dip down to it), a SELL_LIMIT needs entry > price (still
  // waiting for a rally up to it), a BUY_STOP needs entry > price (still waiting for a breakout
  // above it), a SELL_STOP needs entry < price (still waiting for a breakdown below it). Once the
  // real live price has already crossed to the other side, the anticipated move already happened,
  // so this converts the order in code to the equivalent real MARKET action instead -- sl/tp are
  // left exactly as the model decided, unchanged; only `type`/`price` change.
  let marketConversionNote: string | null = null;
  if (isPending && decision.entry !== undefined && referencePrice > 0) {
    const entry = decision.entry;
    const alreadyPassed =
      action === "BUY_LIMIT" ? referencePrice <= entry :
      action === "SELL_LIMIT" ? referencePrice >= entry :
      action === "BUY_STOP" ? referencePrice >= entry :
      /* SELL_STOP */ referencePrice <= entry;
    if (alreadyPassed) {
      const marketOrderType = action === "BUY_LIMIT" || action === "BUY_STOP" ? "buy" : "sell";
      logTick(userId, `${symbol}: ${action} entry ${entry} already reached/passed by the real live price ${referencePrice} -- placing as MARKET ${marketOrderType.toUpperCase()} instead, sl/tp unchanged`);
      order.type = marketOrderType;
      order.price = undefined;
      marketConversionNote = `placed as market -- the limit/stop price had already been reached`;
      // It now fills at the live price, not the old entry: fixed levels move with it and the ratio
      // is re-checked from where it really opens.
      const asMarket = levelsFor({ ...decision, action: marketOrderType === "buy" ? "BUY" : "SELL", entry: undefined });
      if (asMarket.problem) {
        logTick(userId, `${symbol}: converted to market but refused from the live price -- ${asMarket.problem}`);
        recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: `bad risk structure at market: ${asMarket.problem}` });
        return { action: "NONE", symbol, notable: true, message: `⚠️ Skipped ${symbol} -- the ${action} entry had already been passed, and taken at market from here: ${asMarket.problem}` };
      }
      lv = asMarket;
      order.sl = lv.sl;
      order.tp = lv.tp;
    }
  }

  // Real, confirmed bug fixed (user, live: a trade fired at a literal 0% confidence -- "what's
  // the point of placing the market then"). `decision.confidence ?? 0` used to silently treat a
  // missing/unparseable confidence exactly like a real, deliberate 0% score, which then sailed
  // through evaluateConfidenceGate and auto-fired under the default autoApproveBelowThreshold=true
  // policy. `confidence` is now required on the decision tool's schema (see buildDecisionTool
  // above) as the primary fix, but this is defense in depth for a model that still returns a
  // missing/malformed value anyway -- same early-reject-and-SKIP pattern as the "no valid lot
  // size" check above, never a silent stand-in score. A genuine low confidence (e.g. a real 15%)
  // is unaffected -- this only rejects a missing/non-numeric value, not a real low number.
  if (typeof decision.confidence !== "number" || !Number.isFinite(decision.confidence)) {
    logTick(userId, `${symbol}: ${action} rejected -- no valid confidence score was given`);
    recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: "no valid confidence score given" });
    return { action: "NONE", notable: false };
  }
  const confidence = decision.confidence;
  const reason = decision.reason ?? "";

  // Real feature ("Two-step trading" -- a second, independent AI, Flo, approves or declines every
  // trade before it fires). Only ever consulted for a genuine trade action (never management
  // actions -- those already returned above), and only right here, right after the decision (and
  // any limit->market conversion above) is finalized, BEFORE the existing final-gate/tradeExecute
  // path below -- Flo reviews the exact real order that would actually be placed. A decline is
  // treated as a real SKIP: no trade, no execution, same cursor-advance behavior a normal SKIP
  // already gets (the cursor was already advanced above, unconditionally, for every decision).
  let floNote: string | null = null;
  if (getTwoStepTradingEnabled(userId) && !stoppedMidFlight) {
    logTick(userId, `${symbol}: two-step trading is on -- consulting Flo before ${action} can fire`);
    const verdict = await consultFlo({ userId, provider }, decision, contextLines);
    publishActivity(userId, "loop", "flo", { symbol, action, approved: verdict.approved, reason: verdict.reason }, { agent: "flo" });
    if (!verdict.approved) {
      logTick(userId, `${symbol}: Flo declined -- ${verdict.reason}`);
      recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: `Flo declined: ${verdict.reason}` });
      return {
        action: "NONE",
        notable: true,
        message: `🛑 Flo declined ${symbol} ${action} -- no trade placed.\n💡 ${summarizeReason(verdict.reason)}`,
      };
    }
    logTick(userId, `${symbol}: Flo approved -- ${verdict.reason}`);
    floNote = `✅ Flo reviewed and approved -- ${summarizeReason(verdict.reason)}`;
  }

  if (stoppedMidFlight) {
    // Real gap fixed (user, live: "/stop_trading it shouldn't give it offer to place new trade
    // because I just did it now and it's still placing trade"). Whatever was decided, discard it
    // rather than fire -- BUT per the user's own explicit follow-up ask, autonomous trading being
    // stopped isn't a total blackout: a genuinely sniper-tier setup still gets surfaced as a real
    // approve/decline ask instead of just vanishing.
    logTick(userId, `${symbol}: ${action} aborted at the final gate -- trading was stopped mid-cycle`);
    if (!isTradingHalted(userId) && confidence >= SNIPER_TIER_CONFIDENCE) {
      const pendingApproval = queueTradeForApproval(userId, order, confidence, reason);
      recordTickDecision(userId, { ts: Date.now(), symbol, action: decisionAction, reason: `sniper-tier while stopped, asked for approval: ${reason}` });
      return {
        action,
        symbol,
        notable: true,
        message: buildSniperTierWhileStoppedMessage(
          order,
          confidence,
          SNIPER_TIER_CONFIDENCE,
          [marketConversionNote, `${summarizeReason(reason)} (ref #${pendingApproval.id})`].filter(Boolean).join(" -- ")
        ),
        replyMarkup: tradeApprovalKeyboard(pendingApproval.id),
      };
    }
    recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: "trading stopped mid-cycle, decision discarded" });
    return { action: "NONE", notable: false };
  }

  const gate = evaluateConfidenceGate(userId, order, confidence, reason);
  clearHuntState(userId);

  if (gate.needsApproval) {
    recordTickDecision(userId, { ts: Date.now(), symbol, action: decisionAction, reason: `queued for approval: ${reason}` });
    return {
      action,
      symbol,
      notable: true,
      message: buildTradeApprovalRequestMessage(order, confidence, gate.threshold, [marketConversionNote, summarizeReason(reason)].filter(Boolean).join(" -- ")),
      // The real Approve/Decline/Find Another buttons for the exact pending entry
      // evaluateConfidenceGate just queued. `gate.pendingId` used to be read and then thrown
      // away here, which is precisely why the owner's live prompt had nothing to press.
      replyMarkup: tradeApprovalKeyboard(gate.pendingId),
    };
  }

  // Real bug fixed (the trader, live, pointing at his own chart): Dave placed a VOL_80 BUY whose
  // STOP was wider than its TARGET -- risking 3,941 points to gain 3,759, a 0.95:1 risk:reward
  // that needs a >51% win rate just to break even. Nothing in this codebase had ever checked the
  // stop against the target, nor that either sits on the correct side of the entry. See
  // risk-reward-guard.ts.
  // Defence in depth: the same floor, on the real order, against the planned target when TP is off.
  const rr = assessRiskRewardForUser(userId, { ...order, tp: order.tp ?? lv.rrTarget }, order.price ?? lv.entry);
  if (!rr.ok) {
    logTick(userId, `${symbol}: ${action} rejected -- ${rr.reason}`);
    recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: `bad risk structure: ${rr.reason}` });
    return {
      action: "NONE",
      symbol,
      notable: true,
      // Was hardcoded 1:1 language ("stop costs more than its target pays"), which is plainly
      // wrong once the floor is raised -- a 1.5:1 trade refused against a 2:1 setting does not
      // cost more than it pays. Names the trader's own configured floor instead.
      message: `⚠️ Skipped ${symbol} -- ${rr.reason}.\n\nI had a ${decisionAction} read at ${confidence}% confidence, ${/risk:reward/.test(rr.reason ?? "") ? `but your risk:reward floor is ${minRiskReward}:1 and this structure doesn't clear it.` : "but its levels were wrong."}`,
    };
  }

  // Real bug fixed (the trader, live: the very first trade Dave ever tried to place died here
  // with the broker's "failed: not enough money", taking the whole cycle down with it -- and
  // would have repeated on every good setup, so a bot analysing perfectly could never actually
  // trade). Steps the size down until the broker accepts, and tells the trader plainly when the
  // account genuinely can't carry the trade at all. See margin-aware-execute.ts.
  if (isSymbolAvoided(userId, symbol)) {
    logTick(userId, `${symbol}: ${action} refused -- this pair is on the leave-alone list from self-improvement`);
    return { action: "NONE", symbol, notable: false };
  }
  let placed: Awaited<ReturnType<typeof tradeExecuteWithMarginRetry>>;
  try {
    placed = await tradeExecuteWithMarginRetry(executor, order);
  } catch (err) {
    if (err instanceof InsufficientMarginError) {
      logTick(userId, `${symbol}: ${action} rejected -- ${err.message}`);
      recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: "account cannot afford this trade at any lot size" });
      return {
        action: "NONE",
        symbol,
        notable: true,
        message:
          `⚠️ Couldn't place ${symbol} -- your account can't afford it at any size.\n\n` +
          `I found a real ${decisionAction} setup (${confidence}% confidence) and tried down to ${ABSOLUTE_MIN_LOTS} lots, ` +
          `but the broker refused every size for margin. Your free margin is too low for this symbol right now -- ` +
          `close something, top up, or switch to a cheaper instrument.`,
      };
    }
    throw err;
  }
  const reducedSizeNote = placed.reducedForMargin
    ? `\n\n📉 Size reduced to ${placed.placedLots} lots (I wanted ${placed.requestedLots}) -- that's the largest your free margin allowed.`
    : "";
  if (placed.reducedForMargin) {
    logTick(userId, `${symbol}: placed at a reduced ${placed.placedLots} lots (wanted ${placed.requestedLots}) -- broker refused the larger size for margin`);
  }
  try {
    logTrade(db, userId, {
      ticket: placed.ticket,
      symbol: order.symbol,
      direction: decisionAction === "BUY" ? "buy" : "sell",
      entryPrice: order.price ?? lv.entry,
      sl: order.sl,
      tp: order.tp,
      reasoning: reason ? [reason] : [],
      confluenceScore: confidence,
    });
  } catch {
    // Logging must never block or fail a real trade that already succeeded.
  }
  recordTickDecision(userId, { ts: Date.now(), symbol, action: decisionAction, reason });

  // A picture of the trade for the app's chat (setup-drawing.ts): real M15 candles plus the
  // entry/SL/TP. Off the trade's path -- a failed candle fetch just means no picture. The trader
  // can switch it off (Settings > How Dave behaves > Draw my trades).
  if (getAutoDrawTrades(userId)) void (async () => {
    try {
      const { bars } = parseCandles(await analysis.get<unknown>("candles", order.symbol, "M15", { timeoutMs: 30_000 }));
      const drawing = tradeDrawing({
        symbol: order.symbol,
        side: decisionAction === "BUY" ? "buy" : "sell",
        orderType: order.type,
        entry: order.price ?? referencePrice,
        sl: order.sl,
        tp: order.tp,
        candles: bars,
        timeframe: "M15",
        reason,
        lots: placed.placedLots,
      });
      if (drawing) publishActivity(userId, "chat", "drawing", { drawing, caption: drawing.caption ?? drawing.title, ticket: placed.ticket });
    } catch (err) {
      console.warn(`[autonomous-tick] ${userId}: no drawing for #${placed.ticket} -- ${err instanceof Error ? err.message : String(err)}`);
    }
  })();

  // The pullback scalp (the trader: instead of waiting for the limit, ride the pullback into it).
  // Optional -- only when Dave asked for it on this decision -- and only for a limit that is really
  // waiting (not one converted to market above). Never allowed to undo the limit: any problem is
  // reported and the limit stands.
  let pullbackNote: string | null = null;
  // Pullback mode on: every limit gets its pullback scalp, asked for or not (pullback-scalp.ts).
  if (!decision.pullbackScalp && isLimitType(order.type) && getPullbackMode(userId)) decision.pullbackScalp = {};
  const room = decision.pullbackScalp ? pullbackScalpRoom(account ?? undefined, positions.length, risk.maxOpenTrades) : { ok: true };
  if (decision.pullbackScalp && !room.ok) {
    logTick(userId, `${symbol}: pullback scalp skipped -- ${room.reason}`);
    pullbackNote = `🔁 No pullback scalp: ${room.reason}.`;
  } else if (decision.pullbackScalp && isLimitType(order.type) && order.price !== undefined && referencePrice > 0) {
    const planned = planPullbackScalp({
      limitType: order.type,
      limitEntry: order.price,
      limitSl: order.sl,
      price: referencePrice,
      lots: placed.placedLots,
      sl: decision.pullbackScalp?.sl,
      tp2: decision.pullbackScalp?.tp2,
      minRiskReward,
    });
    if (!planned.ok) {
      logTick(userId, `${symbol}: pullback scalp skipped -- ${planned.reason}`);
      pullbackNote = `🔁 No pullback scalp: ${planned.reason}.`;
    } else if (atr > 0 && isSlTooTight(referencePrice, planned.plan.sl, atr)) {
      logTick(userId, `${symbol}: pullback scalp skipped -- SL ${planned.plan.sl} too tight for ATR ${atr}`);
      pullbackNote = `🔁 No pullback scalp: its stop would sit inside normal price noise right now.`;
    } else {
      const scalp = await placePullbackScalp(executor, symbol, planned.plan, {
        comment: `Dave pullback`,
        pushMessage: `Pullback scalp into the ${order.type.replace("_", " ")} at ${order.price}: ${reason}`,
      }, { userId, limitTicket: placed.ticket, entryPrice: referencePrice });
      for (const [key, ticket] of Object.entries(scalp.tickets)) {
        if (!ticket) continue;
        try {
          logTrade(db, userId, {
            ticket,
            symbol,
            direction: planned.plan.side,
            entryPrice: referencePrice,
            sl: planned.plan.sl,
            tp: planned.plan.tp1,
            reasoning: [`Pullback scalp (${key.toUpperCase()}, $20 at a time until the limit) riding price into my ${order.type.replace("_", " ")} at ${order.price}. ${reason}`],
            confluenceScore: confidence,
          });
        } catch {
          // Logging never blocks a real trade.
        }
      }
      logTick(userId, `${symbol}: pullback scalp ${planned.plan.side} (cycle) -- tickets ${JSON.stringify(scalp.tickets)}${scalp.errors.length ? ` errors: ${scalp.errors.join("; ")}` : ""}`);
      pullbackNote = describePullbackScalp(symbol, scalp);
    }
  }

  return {
    action,
    symbol,
    notable: true,
    // Real, live fix (user: the trade-placed push notification's reason line must carry the
    // model's FULL, real, untruncated reasoning -- not summarizeReason's ~2-sentence/~220-char
    // summary. summarizeReason stays exactly as-is for the other, legitimately-short contexts
    // that still use it (DELETE_TICKET/PARTIAL_CLOSE/MODIFY/PAUSE notices, the approval-request
    // messages above) -- this is the one call site that must stop summarizing. Telegram's real
    // sendMessage call in telegram-bot-server.ts chunks this via the shared chunkForTelegram
    // utility, so a rare pathologically long reason still sends in full across multiple messages
    // rather than failing on Telegram's real 4096-char limit or being silently shortened here.
    message:
      [buildTradePlacedMessage({ ...order, lots: placed.placedLots }, placed.ticket, confidence), marketConversionNote, pullbackNote, floNote, `📋 Why: ${reason || "no reason given"}`]
        .filter((line): line is string => line !== null)
        .join("\n\n") + reducedSizeNote,
  };
}

/** The AI setup right now, for the outage back-off (ai-outage.ts). Never throws. */
function currentAiSetup(db: DaveDatabase, userId: string): string | undefined {
  try {
    return aiSetupFingerprint(getModelConfig(userId), (p) => listProviderKeys(db, userId, p as ProviderName).map((k) => ({ id: k.id, model: k.config.model })));
  } catch {
    return undefined;
  }
}

/** A scan question that only asks for an open trade's own numbers (entry, SL, TP, ticket, lots, P&L). */
export function asksForShownTradeData(question: string): boolean {
  const q = question.toLowerCase();
  const asksNumbers = /\b(entry( price)?|open(ing)? price|stop[- ]?loss|\bsl\b|take[- ]?profit|\btp\b|ticket|lot size|lots|p&l|pnl|trade details|position details)\b/.test(q);
  const asksForIt = /\b(what is|what's|what are|need|provide|tell me|share|send|confirm|which)\b/.test(q);
  return asksNumbers && asksForIt;
}
