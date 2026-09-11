import type { DaveDatabase } from "@dave/db";
import type { Provider } from "@dave/brain";
import type { TradeExecutor, OrderRequest, OrderType } from "@dave/trading";
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
import { recordTickDecision, formatRecentDecisions, isOnCooldown, setCooldown, recordSkipForHunt, clearHuntState, HUNT_THRESHOLD } from "./autonomous-tick-state.js";

/**
 * Real replacement for the autonomous cycle's open-ended agentic tool-calling loop, modeled
 * directly on the user's own former bot's proven `tickOne()` (auto-trade-tick/index.ts): one
 * structured decision per cycle, not a multi-turn conversation the model can narrate a halt or a
 * hedge into. Root cause this fixes (confirmed by reading both codebases side by side): an
 * open-ended chat loop with dozens of tools and a long persisted transcript is exactly the
 * structure that let Dave invent its own authority to halt trading, forget trades it had just
 * placed, and hedge on real setups -- there was no hard boundary between "reasoning out loud" and
 * "making a real control-flow decision." A single request/response with no tools attached removes
 * that entire failure class by construction: the model answers the one question it was asked.
 *
 * This module owns the DECISION only. Scheduling (trading-loop.ts, compulsory 1-minute cadence)
 * and the top-level safety gates (isTradingHalted, EA connection, pending question, circuit
 * breaker, drawdown) stay exactly as they are in telegram-bot-server.ts -- this is what runs
 * once those have already passed.
 */

export interface TickDecision {
  action: "BUY" | "SELL" | "SKIP" | "ASK";
  symbol?: string;
  /** Entry price for a pending order; omitted/null means market order. */
  entry?: number | null;
  sl?: number | null;
  tp?: number | null;
  lots?: number;
  confidence?: number;
  reason?: string;
  question?: string;
  options?: string[];
}

export interface TickOutcome {
  action: "BUY" | "SELL" | "SKIP" | "ASK" | "NONE";
  symbol?: string;
  /** Set when a real trade-affecting event happened this tick -- the caller uses this to decide whether to message the user. */
  notable: boolean;
  message?: string;
  huntModeActivated?: boolean;
}

export class InvalidTickDecisionError extends Error {
  constructor(raw: string) {
    super(`Autonomous tick got an unparseable decision -- expected one JSON object, got: ${raw.slice(0, 200)}`);
    this.name = "InvalidTickDecisionError";
  }
}

function parseDecision(text: string): TickDecision {
  const match = text.match(/\{[\s\S]*\}/);
  const raw = match ? match[0] : text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidTickDecisionError(text);
  }
  const obj = parsed as Record<string, unknown>;
  const action = String(obj.action ?? "SKIP").toUpperCase();
  if (action !== "BUY" && action !== "SELL" && action !== "SKIP" && action !== "ASK") {
    throw new InvalidTickDecisionError(text);
  }
  return {
    action,
    symbol: typeof obj.symbol === "string" ? obj.symbol : undefined,
    entry: typeof obj.entry === "number" ? obj.entry : null,
    sl: typeof obj.sl === "number" ? obj.sl : null,
    tp: typeof obj.tp === "number" ? obj.tp : null,
    lots: typeof obj.lots === "number" ? obj.lots : undefined,
    confidence: typeof obj.confidence === "number" ? obj.confidence : undefined,
    reason: typeof obj.reason === "string" ? obj.reason : undefined,
    question: typeof obj.question === "string" ? obj.question : undefined,
    options: Array.isArray(obj.options) ? obj.options.map(String) : undefined,
  };
}

function buildSystemPrompt(): string {
  return `You are Dave, an autonomous MT5 trading AI running one real decision cycle right now. You receive real live market/account context below and must decide: BUY, SELL, SKIP, or ASK.

Use the full real analysis given to you: trend, momentum, volatility, structure, order blocks, RSI/MACD, ATR/Bollinger, volume, patterns, Ichimoku, Fibonacci, correlation, session/news context -- look for real confluence across multiple signals, not a single number.

You may ASK the user a single genuine question only when there is real, specific ambiguity you cannot resolve yourself (e.g. SL disabled on an unusually risky setup, a genuine conflict between timeframes). Prefer SKIP over ASK when in doubt -- most cycles need neither a trade nor a question.

If SL/TP mode is "on", the fixed value shown below is applied automatically -- you don't need to compute it. If SL/TP mode is "auto", you must compute a real sl/tp yourself from the analysis (structure, ATR, support/resistance) and include it in your JSON -- omitting it while auto is active means this cycle is skipped, so always include it. If a mode is "off", omit that field.

If lot mode is "on", the fixed value shown below is applied automatically regardless of what you put in "lots". Otherwise include your own real "lots" sized sensibly against the real account balance shown.

Reply with EXACTLY one JSON object on a single line, no markdown, no other text:
{"action":"BUY","symbol":"EURUSD","entry":null,"sl":1.0820,"tp":1.0900,"lots":0.01,"confidence":72,"reason":"BOS confirmed H1, order block retest, RSI turning up"}
or
{"action":"SELL","symbol":"XAUUSD","entry":4397.42,"sl":4437.87,"tp":4347.56,"lots":0.01,"confidence":58,"reason":"CHoCH M15 sell at FVG, premium zone"}
or
{"action":"SKIP","reason":"no real confluence, choppy structure"}
or
{"action":"ASK","question":"H4 says buy but M15 just printed a CHoCH sell -- which do you want me to weight?","options":["Follow H4 (buy)","Follow M15 (sell)","Skip until aligned"],"reason":"genuinely conflicting timeframes"}

Rules: entry null means a market order; a price means a pending order at that level. If unsure, SKIP -- quality over quantity, but a real, clean setup with real confluence should be taken, not talked out of.`;
}

function resolveOrderType(action: "BUY" | "SELL", entry: number | null, referencePrice: number): OrderType {
  if (entry === null) return action === "BUY" ? "buy" : "sell";
  if (action === "BUY") return entry < referencePrice ? "buy_limit" : "buy_stop";
  return entry > referencePrice ? "sell_limit" : "sell_stop";
}

export interface RunTickDeps {
  userId: string;
  db: DaveDatabase;
  executor: TradeExecutor;
  provider: Provider;
  /** excludeSymbols is used when a hunt broadens past a declined/skipped primary symbol. */
}

export async function runAutonomousTick(deps: RunTickDeps): Promise<TickOutcome> {
  const { userId, db, executor, provider } = deps;

  ensureGroupsUsable(userId);
  if (!isWithinSelectedSession(userId)) return { action: "NONE", notable: false };

  const info = getActiveGroupInfo(userId);
  const primarySymbols = info.effectiveSymbols;
  if (primarySymbols.length === 0) return { action: "NONE", notable: false };

  const account = getLastKnownAccountSnapshot(userId);
  const { positions } = getLastKnownState(userId);
  const risk = getRiskSettings(userId);
  const confidenceSettings = getConfidenceSettings(userId);
  const analysis = createEaAnalysisSource(userId);

  // Real gate ported directly from the reference bot: never signal a symbol already carrying an
  // open position, never re-signal the same symbol inside its real cooldown window.
  const openSymbols = new Set(positions.map((p) => p.symbol.toUpperCase()));
  let candidates = primarySymbols.filter((s) => !openSymbols.has(s.toUpperCase()) && !isOnCooldown(userId, s));
  if (candidates.length === 0) return { action: "NONE", notable: false };

  const symbol = candidates[0];
  const suite = await analysis.get<Record<string, unknown>>("all", symbol, "H1", { timeoutMs: 300_000 }).catch(() => null);
  const priceInfo = (suite as { price?: { bid?: number; ask?: number; close?: number } } | null)?.price;
  const referencePrice = priceInfo?.bid ?? priceInfo?.ask ?? priceInfo?.close ?? 0;

  const contextLines = [
    `SYMBOL: ${symbol}`,
    `PRICE: ${JSON.stringify(priceInfo ?? {})}`,
    `ACCOUNT: balance=${account?.balance ?? "unknown"} equity=${account?.equity ?? "unknown"} freeMargin=${account?.freeMargin ?? "unknown"} leverage=${account?.leverage ?? "unknown"}`,
    `SL_MODE: ${risk.slMode}${risk.slMode === "on" ? ` (fixed ${risk.slValue} pips)` : ""} | TP_MODE: ${risk.tpMode}${risk.tpMode === "on" ? ` (fixed ${risk.tpValue} pips)` : ""} | LOT_MODE: ${risk.lotMode}${risk.lotMode === "on" ? ` (fixed ${risk.lotValue})` : ""}`,
    `CONFIDENCE THRESHOLD: ${confidenceSettings.threshold}% (auto-approve below: ${confidenceSettings.autoApproveBelowThreshold})`,
    `FULL ANALYSIS SUITE: ${JSON.stringify(suite ?? { error: "analysis unavailable this cycle" }).slice(0, 4000)}`,
    formatRecentDecisions(userId),
  ];

  const result = await provider.generate({ messages: [{ role: "system", content: buildSystemPrompt() }, { role: "user", content: contextLines.join("\n") }] }, 60_000);

  let decision: TickDecision;
  try {
    decision = parseDecision(result.text);
  } catch {
    recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: "unparseable model response" });
    return { action: "NONE", notable: false };
  }

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
    // Real hunt-mode broaden, ported from the reference bot's threshold-gated hunt: only after
    // several consecutive skips on a single-pair focus, not every cycle regardless.
    const hunt = await huntForSetup(userId, analysis, "H1", { excludeSymbols: [symbol] });
    if (!hunt.bestSetup) return { action: "NONE", notable: false };
    clearHuntState(userId);
    return {
      action: "NONE",
      notable: true,
      huntModeActivated: true,
      message: `🔍 Hunt Mode Active — no clean setup on ${symbol} after ${skipCount} cycles. Best candidate found scanning the group: ${hunt.bestSetup.symbol} — confluence ${hunt.bestSetup.score}, ${hunt.bestSetup.direction}.`,
    };
  }

  // BUY or SELL from here.
  const order: OrderRequest = {
    symbol,
    type: resolveOrderType(decision.action, decision.entry ?? null, referencePrice),
    lots: risk.lotMode === "on" && risk.lotValue !== undefined ? risk.lotValue : (decision.lots ?? 0),
    price: decision.entry ?? undefined,
  };
  if (order.lots <= 0) {
    recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: "no valid lot size" });
    return { action: "NONE", notable: false };
  }

  const pip = 0.0001;
  const direction = decision.action === "BUY" ? 1 : -1;
  if (decision.sl !== null) order.sl = decision.sl;
  else if (risk.slMode === "on" && risk.slValue !== undefined && referencePrice > 0) order.sl = referencePrice - direction * risk.slValue * pip;
  else if (risk.slMode === "auto") {
    recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: "SL mode is auto but the model didn't compute one" });
    return { action: "NONE", notable: false };
  }
  if (decision.tp !== null) order.tp = decision.tp;
  else if (risk.tpMode === "on" && risk.tpValue !== undefined && referencePrice > 0) order.tp = referencePrice + direction * risk.tpValue * pip;
  else if (risk.tpMode === "auto") {
    recordTickDecision(userId, { ts: Date.now(), symbol, action: "SKIP", reason: "TP mode is auto but the model didn't compute one" });
    return { action: "NONE", notable: false };
  }

  const confidence = decision.confidence ?? 0;
  const reason = decision.reason ?? "";
  const gate = evaluateConfidenceGate(userId, order, confidence, reason);
  setCooldown(userId, symbol);
  clearHuntState(userId);

  if (gate.needsApproval) {
    recordTickDecision(userId, { ts: Date.now(), symbol, action: decision.action, reason: `queued for approval: ${reason}` });
    return {
      action: decision.action,
      symbol,
      notable: true,
      message: `📋 A real ${decision.action} setup on ${symbol} (confidence ${confidence}%, below your ${gate.threshold}% threshold) is queued for your approval.`,
    };
  }

  const placed = await tradeExecute(executor, order);
  try {
    logTrade(db, userId, {
      symbol: order.symbol,
      direction: decision.action === "BUY" ? "buy" : "sell",
      entryPrice: order.price ?? referencePrice,
      sl: order.sl,
      tp: order.tp,
      reasoning: reason ? [reason] : [],
      confluenceScore: confidence,
    });
  } catch {
    // Logging must never block or fail a real trade that already succeeded.
  }
  recordTickDecision(userId, { ts: Date.now(), symbol, action: decision.action, reason });

  return {
    action: decision.action,
    symbol,
    notable: true,
    message: `🤖 ${symbol} ${order.type.toUpperCase()} ${order.price ? `@ ${order.price}` : "(market)"}\nLot ${order.lots}${order.sl ? ` | SL ${order.sl}` : ""}${order.tp ? ` | TP ${order.tp}` : ""}\nConfidence ${confidence}%\n💡 ${reason}\nTicket #${placed.ticket}`,
  };
}
