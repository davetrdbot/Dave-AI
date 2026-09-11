import type { DaveDatabase } from "@dave/db";
import type { Provider, ToolSpec } from "@dave/brain";
import type { TradeExecutor, OrderRequest, OrderType, RiskSettings } from "@dave/trading";
import {
  getRiskSettings,
  getActiveGroupInfo,
  getConfidenceSettings,
  evaluateConfidenceGate,
  tradeExecute,
  huntForSetup,
  isWithinSelectedSession,
  ensureGroupsUsable,
} from "@dave/trading";
import { getLastKnownAccountSnapshot, getLastKnownState, createEaAnalysisSource } from "@dave/ea-bridge";
import { logTrade } from "@dave/feedback";
import { recordTickDecision, formatRecentDecisions, getCursorPosition, advanceCursor, recordSkipForHunt, clearHuntState, HUNT_THRESHOLD } from "./autonomous-tick-state.js";

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
 * This module owns the DECISION only. Scheduling (trading-loop.ts, compulsory 1-minute cadence)
 * and the top-level safety gates (isTradingHalted, EA connection, pending question, circuit
 * breaker, drawdown) stay exactly as they are in telegram-bot-server.ts -- this is what runs
 * once those have already passed.
 */

/** Real multi-timeframe set requested per symbol, per tick -- see the real reason at this
 *  constant's one call site below: the EA's "all" endpoint computes against a single timeframe
 *  only, so genuine multi-timeframe alignment means genuinely asking more than once. M15 for the
 *  scalper read, H1 as the primary/reference price, H4 for the sniper's higher-timeframe context. */
const ANALYSIS_TIMEFRAMES = ["M15", "H1", "H4"] as const;

const TRADE_ACTIONS = ["BUY", "SELL", "BUY_LIMIT", "SELL_LIMIT", "BUY_STOP", "SELL_STOP"] as const;
type TradeAction = (typeof TRADE_ACTIONS)[number];
const DECISION_ACTIONS = [...TRADE_ACTIONS, "SKIP", "ASK"] as const;
type DecisionAction = (typeof DECISION_ACTIONS)[number];

const ACTION_TO_ORDER_TYPE: Record<TradeAction, OrderType> = {
  BUY: "buy",
  SELL: "sell",
  BUY_LIMIT: "buy_limit",
  SELL_LIMIT: "sell_limit",
  BUY_STOP: "buy_stop",
  SELL_STOP: "sell_stop",
};

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
  question?: string;
  options?: string[];
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
 *  to auto, but off it won't ask." */
function buildDecisionTool(risk: RiskSettings): ToolSpec {
  const properties: Record<string, unknown> = {
    action: { type: "string", enum: DECISION_ACTIONS, description: "BUY/SELL are market orders. BUY_LIMIT/SELL_LIMIT/BUY_STOP/SELL_STOP are real pending orders -- include entry. SKIP if there's genuinely nothing. ASK only for real, specific ambiguity." },
    symbol: { type: "string" },
    entry: { type: "number", description: "Required for a pending order type (BUY_LIMIT/SELL_LIMIT/BUY_STOP/SELL_STOP). Omit for market BUY/SELL." },
    lots: { type: "number" },
    confidence: { type: "number", description: "your own honest 0-100 confidence in this specific setup" },
    reason: { type: "string" },
    question: { type: "string", description: "only when action is ASK" },
    options: { type: "array", items: { type: "string" }, description: "only when action is ASK" },
  };
  const required = ["action", "reason"];
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
    question: typeof obj.question === "string" ? obj.question : undefined,
    options: Array.isArray(obj.options) ? obj.options.map(String) : undefined,
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
function buildSystemPrompt(): string {
  return `You are Dave, an autonomous MT5 trading AI. You are a scalper and a sniper, a real risk taker -- you don't sit on real opportunities waiting for textbook perfection. There is nothing like a perfect setup or a perfect entry -- nothing like that exists, nothing. If a real opportunity can bring profit, you take it. When auto-approve is on for this account, that means your decision fires the moment you make it -- no hesitation, no second-guessing yourself after the fact.

You receive one symbol's full real multi-timeframe analysis below, plus this account's real current settings. Decide right now: BUY, SELL, BUY_LIMIT, SELL_LIMIT, BUY_STOP, SELL_STOP, SKIP, or ASK -- call the ${DECISION_TOOL_NAME} tool with your decision, always with your own honest confidence and reasoning.

BUY/SELL are market orders, right now. BUY_LIMIT/SELL_LIMIT/BUY_STOP/SELL_STOP are real pending orders at a specific entry you set -- if you genuinely don't see an immediate scalp or sniper entry, a well-placed limit order waiting for price to come to you is still finding the opportunity, not giving up on it. Prefer SKIP only when there is truly nothing real here, not as a default.

You may ASK a single genuine question only for real, specific ambiguity you cannot resolve yourself. Prefer deciding over asking.

sl/tp: apply automatically when the mode shown below is "on" -- you don't need to compute them, and the field won't even be offered to you. When "auto," you must compute a real sl/tp yourself from the analysis (structure, ATR, support/resistance) and the tool call requires it. When "off," don't include it.

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
 *  that already carries an open position (advancing without spending a decision call on it) --
 *  bounded so an all-positions-open list can't spin forever. */
function resolveCursorSymbol(userId: string, primary: string[], fallback: string[], openSymbols: Set<string>): CursorSymbolResult | null {
  const maxAttempts = primary.length + fallback.length;
  for (let i = 0; i < Math.max(1, maxAttempts); i++) {
    const { symbolCursor, scanningFallback } = getCursorPosition(userId);
    const active = scanningFallback ? fallback : primary;
    if (active.length === 0) {
      advanceCursor(userId, primary.length, fallback.length);
      continue;
    }
    const symbol = active[symbolCursor % active.length];
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
}

/** Real, plain trace of every tick -- there is no other way to see what the bot is actually
 *  doing between real trades than this stdout log (Railway's own log tail). Every early return
 *  used to be silent; now each one says exactly why, and the real chosen symbol/decision/reason
 *  gets logged too, right where it's decided. */
function logTick(userId: string, line: string): void {
  console.log(`[autonomous-tick] ${userId}: ${line}`);
}

export async function runAutonomousTick(deps: RunTickDeps): Promise<TickOutcome> {
  const { userId, db, executor, provider } = deps;

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

  const account = getLastKnownAccountSnapshot(userId);
  const { positions } = getLastKnownState(userId);
  const risk = getRiskSettings(userId);
  const confidenceSettings = getConfidenceSettings(userId);
  const analysis = createEaAnalysisSource(userId);

  const openSymbols = new Set(positions.map((p) => p.symbol.toUpperCase()));
  const picked = resolveCursorSymbol(userId, primarySymbols, fallbackSymbols, openSymbols);
  if (!picked) {
    logTick(userId, `no trade -- every symbol in the active group already has an open position (${[...openSymbols].join(", ") || "none tracked"})`);
    return { action: "NONE", notable: false };
  }
  const { symbol } = picked;
  logTick(userId, `picked ${symbol}${picked.usingFallback ? " (fallback group)" : ""} -- requesting full analysis across ${ANALYSIS_TIMEFRAMES.join("/")}...`);

  // Real gap fixed (user, live: doubted "all timeframes" was genuinely happening -- it wasn't.
  // The EA's own "all" endpoint (DaveEA.mq5's RunAnalysis/A_All) computes every sub-indicator
  // against ONLY the single timeframe it's given -- "get all timeframes in one call" isn't a
  // real capability on the EA side, so a single analysis.get("all", symbol, "H1") call was never
  // actually multi-timeframe, no matter what the context block claimed. This genuinely requests
  // "all" once per real timeframe and merges them, so multi-timeframe alignment (the sniper/
  // scalper mandate in trading.md) is real data the model actually receives, not a label on a
  // single H1 read.
  const suiteByTimeframe = await Promise.all(
    ANALYSIS_TIMEFRAMES.map((tf) =>
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
  for (const { tf, data } of suiteByTimeframe) suite[tf] = data ?? { error: "unavailable this cycle" };

  const primaryTfResult = suiteByTimeframe.find((r) => r.tf === "H1")?.data ?? suiteByTimeframe.find((r) => r.data)?.data;
  const priceInfo = (primaryTfResult as { price?: { bid?: number; ask?: number; close?: number } } | null)?.price;
  const referencePrice = priceInfo?.bid ?? priceInfo?.ask ?? priceInfo?.close ?? 0;

  const contextLines = [
    `SYMBOL: ${symbol}`,
    `PRICE: ${JSON.stringify(priceInfo ?? {})}`,
    `ACCOUNT: balance=${account?.balance ?? "unknown"} equity=${account?.equity ?? "unknown"} freeMargin=${account?.freeMargin ?? "unknown"} leverage=${account?.leverage ?? "unknown"}`,
    `SL_MODE: ${risk.slMode}${risk.slMode === "on" ? ` (fixed ${risk.slValue} pips)` : ""} | TP_MODE: ${risk.tpMode}${risk.tpMode === "on" ? ` (fixed ${risk.tpValue} pips)` : ""} | LOT_MODE: ${risk.lotMode}${risk.lotMode === "on" ? ` (fixed ${risk.lotValue})` : ""}`,
    `CONFIDENCE THRESHOLD: ${confidenceSettings.threshold}%`,
    buildTradeAdviceBlock(confidenceSettings),
    `FULL ANALYSIS SUITE, genuinely one real "all" call per timeframe (${ANALYSIS_TIMEFRAMES.join(", ")}), merged below -- check for real alignment or conflict across them, not just one: ${JSON.stringify(suite).slice(0, 6000)}`,
    formatRecentDecisions(userId),
  ];

  const tool = buildDecisionTool(risk);
  let result;
  try {
    result = await provider.generate(
      { messages: [{ role: "system", content: buildSystemPrompt() }, { role: "user", content: contextLines.join("\n") }], tools: [tool], toolChoice: { name: DECISION_TOOL_NAME } },
      60_000
    );
  } catch (err) {
    logTick(userId, `model call for ${symbol} failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }

  let decision: TickDecision;
  try {
    const toolCall = result.toolCalls?.find((c) => c.name === DECISION_TOOL_NAME);
    decision = toolCall ? coerceDecision(toolCall.arguments) : parseDecisionFromText(result.text);
  } catch {
    logTick(userId, `${symbol}: unparseable model response -- raw text: ${result.text.slice(0, 300)}`);
    recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: "unparseable model response" });
    advanceCursor(userId, primarySymbols.length, fallbackSymbols.length);
    return { action: "NONE", notable: false };
  }

  logTick(userId, `${symbol}: model decided ${decision.action}${decision.confidence !== undefined ? ` (confidence ${decision.confidence}%)` : ""} -- ${decision.reason ?? decision.question ?? "no reason given"}`);

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

  // A real trade action from here.
  const action = decision.action as TradeAction;
  const orderType = ACTION_TO_ORDER_TYPE[action];
  const isPending = orderType !== "buy" && orderType !== "sell";
  if (isPending && decision.entry === undefined) {
    logTick(userId, `${symbol}: ${action} rejected -- needs an entry price and none was given`);
    recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: `${action} needs an entry price and none was given` });
    return { action: "NONE", notable: false };
  }

  const order: OrderRequest = {
    symbol,
    type: orderType,
    lots: risk.lotMode === "on" && risk.lotValue !== undefined ? risk.lotValue : (decision.lots ?? 0),
    price: decision.entry,
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
  else if (risk.slMode === "on" && risk.slValue !== undefined && referencePrice > 0) order.sl = referencePrice - direction * risk.slValue * pip;
  else if (risk.slMode === "auto") {
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
  const gate = evaluateConfidenceGate(userId, order, confidence, reason);
  clearHuntState(userId);

  if (gate.needsApproval) {
    recordTickDecision(userId, { ts: Date.now(), symbol, action: decisionAction, reason: `queued for approval: ${reason}` });
    return {
      action,
      symbol,
      notable: true,
      message: `📋 A real ${action} setup on ${symbol} (confidence ${confidence}%, below your ${gate.threshold}% threshold) is queued for your approval.`,
    };
  }

  const placed = await tradeExecute(executor, order);
  try {
    logTrade(db, userId, {
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
    message: `🤖 ${symbol} ${orderType.toUpperCase()} ${order.price ? `@ ${order.price}` : "(market)"}\nLot ${order.lots}${order.sl ? ` | SL ${order.sl}` : ""}${order.tp ? ` | TP ${order.tp}` : ""}\nConfidence ${confidence}%\n💡 ${reason}\nTicket #${placed.ticket}`,
  };
}
