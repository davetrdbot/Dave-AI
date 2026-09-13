import type { DaveDatabase } from "@dave/db";
import type { Provider, ToolSpec } from "@dave/brain";
import type { TradeExecutor, OrderRequest, OrderType, RiskSettings } from "@dave/trading";
import {
  getRiskSettings,
  getActiveGroupInfo,
  getConfidenceSettings,
  evaluateConfidenceGate,
  queueTradeForApproval,
  tradeExecute,
  tradeModify,
  partialClose,
  fullClose,
  deletePendingOrder,
  huntForSetup,
  isWithinSelectedSession,
  ensureGroupsUsable,
  isMarketOpenForSymbol,
  isSlTooTight,
  getSelfPauseEnabled,
  getAnalysisConfig,
  filterSuiteToConfig,
} from "@dave/trading";
import { isTradingHalted } from "@dave/safety";
import { getLastKnownAccountSnapshot, getLastKnownState, createEaAnalysisSource } from "@dave/ea-bridge";
import { logTrade, getTradeLifecycle } from "@dave/feedback";
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
} from "./autonomous-tick-state.js";
import { isAutonomousExecutionEnabled } from "./autonomous-trading-state.js";
import { setSelfPause, getSelfPause, MAX_SELF_PAUSE_MINUTES } from "./self-pause.js";
import { recordAnalysisFetch } from "./analysis-debug-store.js";
import { buildTradePlacedMessage, buildTradeApprovalRequestMessage, buildSniperTierWhileStoppedMessage, summarizeReason, buildProgressBar } from "./trade-notifications.js";
import { loadSystemPrompt } from "./system-prompt.js";
import { consultJournal } from "./journal-agent.js";

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
 *  explicit spec: M1/M3/M5 for the scalper's short-term read, M15/H1 for the mid-term picture,
 *  H4 for the sniper's higher-timeframe context -- all six genuinely confirmed supported by the
 *  EA's own TimeframeFromString (ea/DaveEA.mq5). */
const ANALYSIS_TIMEFRAMES = ["M1", "M3", "M5", "M15", "H1", "H4"] as const;

const TRADE_ACTIONS = ["BUY", "SELL", "BUY_LIMIT", "SELL_LIMIT", "BUY_STOP", "SELL_STOP"] as const;
type TradeAction = (typeof TRADE_ACTIONS)[number];
/** Real gap fixed (user, live: "add a tool to delete the existing trade... a tool that the bot
 *  can pause... a tool like partial close"). Kept inside the SAME one-forced-tool-call schema as
 *  the trade actions -- these are alternate values of the one `action` field, not a second tool
 *  the model can freely reach for, so the "one structured decision per tick" architecture is
 *  never reopened into an agentic multi-tool loop. */
const MANAGEMENT_ACTIONS = ["DELETE_TICKET", "PARTIAL_CLOSE", "MODIFY", "PAUSE", "CONSULT_JOURNAL", "REQUEST_CANDLES"] as const;
const DECISION_ACTIONS = [...TRADE_ACTIONS, ...MANAGEMENT_ACTIONS, "SKIP", "ASK"] as const;
type DecisionAction = (typeof DECISION_ACTIONS)[number];

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

/** Real, live-stated bar (user's own number, exact: "89%"). Real SL-progress -- genuine distance
 *  travelled from a real open position's entry toward its real SL, as a fraction of the real
 *  entry-to-SL distance (see buildProgressBar in trade-notifications.ts, the same math the visual
 *  bar renders) -- at or beyond this fraction triggers the SELF-AWARE ALERT context line below,
 *  for ANY open position account-wide, not just the current round-robin symbol's own position. */
const SL_DANGER_THRESHOLD = 0.89;

export interface TickDecision {
  action: DecisionAction;
  symbol?: string;
  /** Required for BUY_LIMIT/SELL_LIMIT/BUY_STOP/SELL_STOP; unused for market BUY/SELL. */
  entry?: number;
  sl?: number;
  tp?: number;
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
}

export interface TickOutcome {
  action: DecisionAction | "NONE";
  symbol?: string;
  /** Set when a real trade-affecting event happened this tick -- the caller uses this to decide whether to message the user. */
  notable: boolean;
  message?: string;
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
function buildDecisionTool(risk: RiskSettings): ToolSpec {
  const properties: Record<string, unknown> = {
    action: {
      type: "string",
      enum: DECISION_ACTIONS,
      description:
        "BUY/SELL are market orders. BUY_LIMIT/SELL_LIMIT/BUY_STOP/SELL_STOP are real pending orders -- include entry. " +
        "DELETE_TICKET closes an existing open position or removes an existing pending order (needs ticket). " +
        "PARTIAL_CLOSE closes part of an existing open position (needs ticket and closeLots). " +
        "MODIFY adjusts SL/TP on an existing open position (needs ticket; optional newSl/newTp -- pass a number to set it, null to explicitly remove it, or omit to leave it unchanged). " +
        "PAUSE stops you from opening new trades for a short while when you judge exposure is already high (optional pauseMinutes, 1-5). " +
        "CONSULT_JOURNAL asks Journal, your trade-review sidekick, for a second opinion before you commit -- optional, never required; you'll be asked to decide again right after with its answer in hand. " +
        "REQUEST_CANDLES fetches one fresh real batch of candles (for the at-risk symbol if a SELF-AWARE ALERT is active below, otherwise for the symbol you're currently analyzing) so you decide with current price action, not stale data -- optional, never required, available on any cycle, at most once; you'll be asked to decide again right after with the candles in hand. " +
        "SKIP if there's genuinely nothing. ASK only for real, specific ambiguity.",
    },
    symbol: { type: "string" },
    entry: { type: "number", description: "Required for a pending order type (BUY_LIMIT/SELL_LIMIT/BUY_STOP/SELL_STOP). Omit for market BUY/SELL." },
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
  };
  const required = ["action", "reason"];
  if (risk.lotMode !== "on") required.push("lots");
  if (risk.slMode !== "off") properties.sl = { type: "number" };
  if (risk.slMode === "auto") required.push("sl");
  if (risk.tpMode !== "off") properties.tp = { type: "number" };
  if (risk.tpMode === "auto") required.push("tp");
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
    lots: typeof obj.lots === "number" ? obj.lots : undefined,
    confidence: typeof obj.confidence === "number" ? obj.confidence : undefined,
    reason: typeof obj.reason === "string" ? obj.reason : undefined,
    strategyTag: typeof obj.strategyTag === "string" ? obj.strategyTag : undefined,
    question: typeof obj.question === "string" ? obj.question : undefined,
    options: Array.isArray(obj.options) ? obj.options.map(String) : undefined,
    ticket: typeof obj.ticket === "string" ? obj.ticket : undefined,
    closeLots: typeof obj.closeLots === "number" ? obj.closeLots : undefined,
    pauseMinutes: typeof obj.pauseMinutes === "number" ? obj.pauseMinutes : undefined,
    // Real semantics (must match tradeModify/modifyOrder exactly): explicit null means "remove
    // this SL/TP", a real number means "set it", and genuinely absent/undefined -- including any
    // other unexpected type -- means "leave it unchanged". `"newSl" in obj` is what distinguishes
    // an explicit null from a key that was never sent at all.
    newSl: typeof obj.newSl === "number" ? obj.newSl : "newSl" in obj && obj.newSl === null ? null : undefined,
    newTp: typeof obj.newTp === "number" ? obj.newTp : "newTp" in obj && obj.newTp === null ? null : undefined,
    requestedNextSymbol: typeof obj.requestedNextSymbol === "string" && obj.requestedNextSymbol.length > 0 ? obj.requestedNextSymbol : undefined,
    requestedNextReason: typeof obj.requestedNextReason === "string" ? obj.requestedNextReason : undefined,
  };
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

You receive one symbol's full real multi-timeframe analysis below, plus this account's real current settings, and a real summary of what's already open -- including, per open position that has both a real SL and TP, a visual progress bar toward each. Decide right now: BUY, SELL, BUY_LIMIT, SELL_LIMIT, BUY_STOP, SELL_STOP, DELETE_TICKET, PARTIAL_CLOSE, MODIFY, PAUSE, CONSULT_JOURNAL, REQUEST_CANDLES, SKIP, or ASK -- call the ${DECISION_TOOL_NAME} tool with your decision, always with your own honest confidence and reasoning.

BUY/SELL are market orders, right now. BUY_LIMIT/SELL_LIMIT/BUY_STOP/SELL_STOP are real pending orders at a specific entry you set -- if you genuinely don't see an immediate scalp or sniper entry, a well-placed limit order waiting for price to come to you is still finding the opportunity, not giving up on it. Prefer SKIP only when there is truly nothing real here, not as a default.

You may ASK a single genuine question only for real, specific ambiguity you cannot resolve yourself. Prefer deciding over asking.

DELETE_TICKET closes an existing open position or cancels an existing pending order you no longer want -- use it with a real ticket from OPEN POSITIONS/PENDING ORDERS below. PARTIAL_CLOSE takes some profit/reduces risk on part of an existing position (needs ticket + closeLots) without closing it entirely. MODIFY adjusts SL and/or TP on an existing open position (needs ticket) without closing anything -- pass newSl/newTp as a number to set it, null to explicitly remove it, or omit either to leave it unchanged. PAUSE stops you from opening ANY new trade for a short while (1-5 minutes, your call) when you judge there's already enough real open exposure -- you can still ASK, DELETE_TICKET, PARTIAL_CLOSE, or MODIFY while paused, just not open something new.

CONSULT_JOURNAL asks Journal, your trade-review sidekick, for a second, honest opinion before you commit -- entirely optional, never required. Journal has its own access to trade history and analysis tools; it reviews and comments, it never places or modifies a trade itself. Use it when a setup is genuinely borderline and a second read would help, not as a default detour. After Journal answers, you'll be asked to decide again with its opinion in hand.

REQUEST_CANDLES gets you one fresh real batch of candle data for the symbol you're analyzing right now before you finalize your decision -- entirely optional, never required, available on any cycle, at most once. After the candles come back, you'll be asked to decide again with them in hand -- do not request candles a second time.

If a SELF-AWARE ALERT appears below, one of your real open positions is genuinely close to hitting its SL -- REQUEST_CANDLES there fetches for that at-risk symbol instead. After the candles come back, act directly with MODIFY (tighten/loosen/adjust), DELETE_TICKET (cut it now), PARTIAL_CLOSE, or SKIP if it genuinely still looks fine.

You may also set requestedNextSymbol (with a real requestedNextReason) on ANY decision to ask that a specific symbol be analyzed next cycle instead of the mechanical round-robin order -- e.g. to follow up on a trade you just took, or to check back once a candle you're watching closes. Optional, never required.

sl/tp: apply automatically when the mode shown below is "on" -- you don't need to compute them, and the field won't even be offered to you. When "auto," you must compute a real sl/tp yourself from the analysis (structure, ATR, support/resistance) and the tool call requires it. A stop placed unreasonably close to price will be rejected -- size it to real, current volatility, not habit. When "off," don't include it.

lots: applied automatically when mode is "on." Otherwise include your own real sizing against the real account balance shown -- size to win, not timidly.`;
}

function buildTradeAdviceBlock(confidence: ReturnType<typeof getConfidenceSettings>): string {
  const autoNote = confidence.autoApproveBelowThreshold
    ? "Auto-approve is ON for below-threshold setups -- a real decision you make fires immediately, it does not wait on anyone. Take the opportunity."
    : `Auto-approve is OFF -- a decision below ${confidence.threshold}% confidence queues for the user's approval instead of firing immediately. That's expected, not a reason to hold back on a real read.`;
  return `You are a risk taker. Find a setup and take the opportunity -- a scalp or a sniper entry, or a well-placed limit order if you don't see an immediate one. ${autoNote}`;
}

interface CursorSymbolResult {
  symbol: string;
  usingFallback: boolean;
}

/** Resolves the real symbol for THIS tick from the round-robin cursor, skipping past any symbol
 *  that already carries an open position, or whose real market is genuinely closed right now
 *  (user, live: "whether market is closed that's for forex it shouldn't analyze that even set as
 *  fallback too") -- advancing without spending a decision call on either case, bounded so an
 *  all-closed/all-open list can't spin forever. */
function resolveCursorSymbol(userId: string, primary: string[], fallback: string[], openSymbols: Set<string>, groupIdFor: (symbol: string, usingFallback: boolean) => string | null): CursorSymbolResult | null {
  // Real requested-next-symbol override (user, live: the model can note "analyze SYMBOL next,
  // because REASON" on any decision, and the round-robin honors that specific symbol on the VERY
  // NEXT cycle). Consumed exactly once regardless of outcome -- a stale/invalid request never
  // sticks around to be retried on a later cycle, it just falls back to normal round-robin THIS
  // cycle. Only ever honored if the requested symbol is still genuinely valid right now -- the
  // exact same real checks (still in the active group, market open, no existing position) a normal
  // round-robin symbol must pass, never skipped for an override. The round-robin cursor itself is
  // left untouched either way -- honoring an override is a one-off substitution, not a cursor jump.
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
}

/** Real, plain trace of every tick -- there is no other way to see what the bot is actually
 *  doing between real trades than this stdout log (Railway's own log tail). Every early return
 *  used to be silent; now each one says exactly why, and the real chosen symbol/decision/reason
 *  gets logged too, right where it's decided. */
function logTick(userId: string, line: string): void {
  console.log(`[autonomous-tick] ${userId}: ${line}`);
}

export async function runAutonomousTick(deps: RunTickDeps): Promise<TickOutcome> {
  const { userId, db, executor, provider, signal } = deps;

  ensureGroupsUsable(userId);
  if (!isWithinSelectedSession(userId)) {
    logTick(userId, "no trade -- outside the selected trading session window");
    return { action: "NONE", notable: false };
  }

  const info = getActiveGroupInfo(userId);
  const primarySymbols = info.effectiveSymbols;
  if (primarySymbols.length === 0) {
    logTick(userId, "no trade -- no active pair group or pair configured");
    return { action: "NONE", notable: false };
  }
  const fallbackSymbols = !info.activePairSymbol ? (info.fallbackGroup?.symbols ?? []) : [];
  // Real bug fixed (test regression, step12): once a single-pair override is active, the active
  // GROUP's category is irrelevant to the overridden symbol -- pass null so isForexSymbol falls
  // through to pure shape-sniffing instead of trusting a group id that no longer describes what's
  // actually being scanned (e.g. an active "forex" group overridden to XAUUSD, a metal).
  const groupIdFor = (_symbol: string, usingFallback: boolean): string | null =>
    usingFallback ? (info.fallbackGroup?.id ?? null) : info.activePairSymbol ? null : (info.activeGroup?.id ?? null);

  const account = getLastKnownAccountSnapshot(userId);
  const { positions, pendingOrders } = getLastKnownState(userId);
  const risk = getRiskSettings(userId);
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
    logTick(userId, `no trade -- at max open trades (${positions.length}/${risk.maxOpenTrades})`);
    return { action: "NONE", notable: false };
  }

  const openSymbols = new Set(positions.map((p) => p.symbol.toUpperCase()));
  const picked = resolveCursorSymbol(userId, primarySymbols, fallbackSymbols, openSymbols, groupIdFor);
  if (!picked) {
    logTick(userId, `no trade -- every symbol in the active group already has an open position or a closed market (${[...openSymbols].join(", ") || "none tracked"})`);
    return { action: "NONE", notable: false };
  }
  const { symbol } = picked;
  const activeTimeframes = analysisConfig.mode === "custom" && analysisConfig.timeframes.length > 0 ? analysisConfig.timeframes : ANALYSIS_TIMEFRAMES;
  logTick(userId, `picked ${symbol}${picked.usingFallback ? " (fallback group)" : ""} -- requesting full analysis across ${activeTimeframes.join("/")}...`);

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
        .then((data) => ({ tf, data }))
        .catch((err) => {
          logTick(userId, `analysis for ${symbol} (${tf}) failed/timed out: ${err instanceof Error ? err.message : String(err)}`);
          return { tf, data: null };
        })
    )
  );
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

  const primaryTfResult = suiteByTimeframe.find((r) => r.tf === "H1")?.data ?? suiteByTimeframe.find((r) => r.data)?.data;
  const priceInfo = (primaryTfResult as { price?: { bid?: number; ask?: number; close?: number } } | null)?.price;
  const referencePrice = priceInfo?.bid ?? priceInfo?.ask ?? priceInfo?.close ?? 0;
  const atr = (primaryTfResult as { volatility?: { atr?: number } } | null)?.volatility?.atr ?? 0;

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
    const slDenominator = Math.abs(p.sl - p.openPrice);
    const slProgress = slDenominator === 0 ? 0 : Math.min(1, Math.max(0, Math.abs(p.currentPrice - p.openPrice) / slDenominator));
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
          const base = `${p.symbol} ${p.type.toUpperCase()} ${p.lots} lots @ ${p.openPrice}${p.sl !== undefined ? ` SL ${p.sl}` : ""}${p.tp !== undefined ? ` TP ${p.tp}` : ""} pnl=${p.pnl ?? "?"} #${p.ticket}`;
          const progress = positionsProgress.get(p.ticket);
          return progress ? `${base} | Progress to TP: ${progress.tpBar} | Progress to SL: ${progress.slBar}` : base;
        })
        .join("; ")
    : "none";
  const pendingSummary = pendingOrders.length ? pendingOrders.map((p) => `${p.symbol} ${p.type.toUpperCase()} ${p.lots} lots @ ${p.price} #${p.ticket}`).join("; ") : "none";

  // Real self-aware SL-danger alert (user's own exact stated bar, 89%): ANY open position
  // account-wide at/beyond SL_DANGER_THRESHOLD, not just the current round-robin symbol's own
  // position -- picks the single worst (highest SL-progress) one if more than one qualifies, and
  // pulls its REAL original placement reason from the real trade journal by ticket (never a
  // placeholder), matching exactly how getTradeLifecycle/journal-agent.ts already read a stored
  // trade's reason by ticket elsewhere in this codebase.
  const dangerPosition = [...positionsProgress.values()].filter((pp) => pp.slProgress >= SL_DANGER_THRESHOLD).sort((a, b) => b.slProgress - a.slProgress)[0] ?? null;
  let selfAwareAlertLine: string | null = null;
  if (dangerPosition) {
    const lifecycle = getTradeLifecycle(db, userId, { ticket: dangerPosition.ticket });
    const originalReason = lifecycle[0]?.reasoning?.length ? lifecycle[0].reasoning.join(" ") : (lifecycle[0]?.narrative ?? "no original placement reason recorded in the trade journal");
    logTick(
      userId,
      `SELF-AWARE ALERT: ticket #${dangerPosition.ticket} (${dangerPosition.symbol}) is at ${Math.round(dangerPosition.slProgress * 100)}% progress toward its SL`
    );
    selfAwareAlertLine = `SELF-AWARE ALERT: Ticket #${dangerPosition.ticket} (${dangerPosition.symbol}) is at ${Math.round(dangerPosition.slProgress * 100)}% real progress toward its SL -- genuinely close to being stopped out. Original real reason when this trade was placed: "${originalReason}". You may REQUEST_CANDLES for ${dangerPosition.symbol} for one fresh look before deciding, or act now with MODIFY/DELETE_TICKET/PARTIAL_CLOSE/SKIP.`;
  }

  const selfPause = getSelfPause(userId);

  const contextLines = [
    `SYMBOL: ${symbol}`,
    `PRICE: ${JSON.stringify(priceInfo ?? {})}`,
    `ACCOUNT: balance=${account?.balance ?? "unknown"} equity=${account?.equity ?? "unknown"} freeMargin=${account?.freeMargin ?? "unknown"} leverage=${account?.leverage ?? "unknown"}`,
    `SL_MODE: ${risk.slMode}${risk.slMode === "on" ? ` (fixed ${risk.slValue} pips)` : ""} | TP_MODE: ${risk.tpMode}${risk.tpMode === "on" ? ` (fixed ${risk.tpValue} pips)` : ""} | LOT_MODE: ${risk.lotMode}${risk.lotMode === "on" ? ` (fixed ${risk.lotValue})` : ""}`,
    `CONFIDENCE THRESHOLD: ${confidenceSettings.threshold}%`,
    buildTradeAdviceBlock(confidenceSettings),
    // Real gap fixed (user, live: "it doesn't know the pending orders it just place and the
    // active" / wants position info shown "when it knows that the trade it opened is already
    // plenty"). Every cycle, regardless of which symbol was picked, sees the real current
    // exposure -- this is what actually gives the model position awareness, not just the hard
    // maxOpenTrades ceiling above.
    `OPEN POSITIONS (${positions.length}${risk.maxOpenTrades !== undefined ? `/${risk.maxOpenTrades} max` : ""}): ${positionsSummary}`,
    `PENDING ORDERS: ${pendingSummary}`,
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
    formatRecentDecisions(userId),
    selfAwareAlertLine,
  ].filter((line): line is string => line !== null);

  const tool = buildDecisionTool(risk);

  async function requestDecision(lines: string[]): Promise<TickDecision | null> {
    let genResult;
    try {
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
        logTick(userId, `${symbol}: model call interrupted by a real user message -- backing off, will retry this symbol next cycle`);
        throw new TickAbortedError();
      }
      logTick(userId, `model call for ${symbol} failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    try {
      const toolCall = genResult.toolCalls?.find((c) => c.name === DECISION_TOOL_NAME);
      return toolCall ? coerceDecision(toolCall.arguments) : parseDecisionFromText(genResult.text);
    } catch {
      logTick(userId, `${symbol}: unparseable model response -- raw text: ${genResult.text.slice(0, 300)}`);
      return null;
    }
  }

  let decision: TickDecision | null;
  try {
    decision = await requestDecision(contextLines);
  } catch (err) {
    if (err instanceof TickAbortedError) {
      recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: "interrupted by a real user message" });
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
    recordTickDecision(userId, { ts: Date.now(), symbol, action: "CONSULT_JOURNAL", reason: decision.reason ?? "" });
    let decisionAfterConsult: TickDecision | null;
    try {
      decisionAfterConsult = await requestDecision([...contextLines, `JOURNAL'S OPINION (you asked for this -- decide now, do not consult again): ${journalResult.opinion}`]);
    } catch (err) {
      if (err instanceof TickAbortedError) {
        recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: "interrupted by a real user message" });
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
        recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: "interrupted by a real user message" });
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

  logTick(userId, `${symbol}: model decided ${decision.action}${decision.confidence !== undefined ? ` (confidence ${decision.confidence}%)` : ""} -- ${decision.reason ?? decision.question ?? "no reason given"}`);

  // Real requested-next-symbol override -- can accompany ANY decision (BUY/SELL/SKIP/etc, not a
  // separate action), persisted right after the real decision is recorded so resolveCursorSymbol
  // picks it up on the VERY NEXT cycle. Overwrites any previous still-pending override.
  if (decision.requestedNextSymbol) {
    const overrideReason = decision.requestedNextReason ?? "no reason given";
    logTick(userId, `${symbol}: requesting ${decision.requestedNextSymbol} for the next cycle -- ${overrideReason}`);
    setPendingSymbolOverride(userId, decision.requestedNextSymbol, overrideReason);
  }

  // The cursor always advances after a real decision, regardless of outcome -- this is what
  // keeps the loop moving through the whole group instead of getting stuck on one symbol.
  advanceCursor(userId, primarySymbols.length, fallbackSymbols.length);

  if (decision.action === "ASK") {
    if (!decision.question) return { action: "NONE", notable: false };
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
    const closeResult = await partialClose(executor, decision.ticket, decision.closeLots);
    recordTickDecision(userId, { ts: Date.now(), symbol, action: "PARTIAL_CLOSE", reason });
    return {
      action: "PARTIAL_CLOSE",
      symbol,
      notable: true,
      message: `✂️ Partially closed ${decision.closeLots} lots on ticket #${decision.ticket} (${closeResult.remainingLots} lots remain)\n💡 ${summarizeReason(reason || "no reason given")}`,
    };
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
      logTick(userId, `${symbol}: MODIFY rejected -- ticket #${decision.ticket} isn't a real open position`);
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
    return { action: "PAUSE", symbol, notable: true, message: `⏸ Self-pausing for ${minutesLeft}m\n💡 ${summarizeReason(reason)}` };
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
  if (decision.sl !== undefined && atr > 0 && isSlTooTight(referencePrice, decision.sl, atr)) {
    logTick(userId, `${symbol}: ${action} rejected -- SL ${decision.sl} is too tight relative to current ATR ${atr} (real price noise would likely stop this out immediately)`);
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
    price: decision.entry,
    // Real, live fix (user: the old `Dave ${confidence}% ${reason}`.slice(0, 40) comment crammed
    // as much of the real reasoning text as fit into 40 chars -- garbled/cut off mid-word or
    // mid-sentence on the MT5 side). Short and structured instead: confidence + a short
    // strategy/setup tag, nothing else -- the real, full reasoning goes out in full via the
    // Telegram push notification below, never here. `strategyTag` is optional on the schema (not
    // every action needs it), so a genuinely conservative fallback ("setup") keeps the comment
    // well-formed even if the model omits it; 28 chars is comfortably inside MT5's real
    // broker-enforced comment limit.
    comment: `Dave:${decision.confidence ?? "?"}% ${decision.strategyTag ?? "setup"}`.slice(0, 28).trimEnd(),
  };
  if (order.lots <= 0) {
    logTick(userId, `${symbol}: ${action} rejected -- no valid lot size (lot mode=${risk.lotMode}, model gave lots=${decision.lots ?? "none"})`);
    recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: "no valid lot size" });
    return { action: "NONE", notable: false };
  }

  const pip = 0.0001;
  const direction = action === "BUY" || action === "BUY_LIMIT" || action === "BUY_STOP" ? 1 : -1;
  const decisionAction = action === "BUY" || action === "BUY_LIMIT" || action === "BUY_STOP" ? "BUY" : "SELL";
  if (decision.sl !== undefined) order.sl = decision.sl;
  else if (risk.slMode === "on" && risk.slValue !== undefined && referencePrice > 0) {
    const candidateSl = referencePrice - direction * risk.slValue * pip;
    if (atr > 0 && isSlTooTight(referencePrice, candidateSl, atr)) {
      logTick(userId, `${symbol}: ${action} rejected -- the user's fixed ${risk.slValue}-pip SL is too tight relative to current ATR ${atr}`);
      recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: "fixed SL is too tight relative to current volatility" });
      return { action: "NONE", notable: false };
    }
    order.sl = candidateSl;
  } else if (risk.slMode === "auto") {
    logTick(userId, `${symbol}: ${action} rejected -- SL mode is auto but the model didn't compute one`);
    recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: "SL mode is auto but the model didn't compute one" });
    return { action: "NONE", notable: false };
  }
  if (decision.tp !== undefined) order.tp = decision.tp;
  else if (risk.tpMode === "on" && risk.tpValue !== undefined && referencePrice > 0) order.tp = referencePrice + direction * risk.tpValue * pip;
  else if (risk.tpMode === "auto") {
    logTick(userId, `${symbol}: ${action} rejected -- TP mode is auto but the model didn't compute one`);
    recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: "TP mode is auto but the model didn't compute one" });
    return { action: "NONE", notable: false };
  }

  const confidence = decision.confidence ?? 0;
  const reason = decision.reason ?? "";

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
        message: buildSniperTierWhileStoppedMessage(order, confidence, SNIPER_TIER_CONFIDENCE, `${summarizeReason(reason)} (ref #${pendingApproval.id})`),
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
      message: buildTradeApprovalRequestMessage(order, confidence, gate.threshold, summarizeReason(reason)),
    };
  }

  const placed = await tradeExecute(executor, order);
  try {
    logTrade(db, userId, {
      ticket: placed.ticket,
      symbol: order.symbol,
      direction: decisionAction === "BUY" ? "buy" : "sell",
      entryPrice: order.price ?? referencePrice,
      sl: order.sl,
      tp: order.tp,
      reasoning: reason ? [reason] : [],
      confluenceScore: confidence,
    });
  } catch {
    // Logging must never block or fail a real trade that already succeeded.
  }
  recordTickDecision(userId, { ts: Date.now(), symbol, action: decisionAction, reason });

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
    message: [buildTradePlacedMessage(order, placed.ticket, confidence), `📋 Why: ${reason || "no reason given"}`].join("\n\n"),
  };
}
