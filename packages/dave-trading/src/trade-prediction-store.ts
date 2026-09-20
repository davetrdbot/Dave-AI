import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Prediction-vs-reality tracking and similar-trade memory (the trader's Self-Awareness spec, parts
 * 4 and 5).
 *
 *  - Before a trade, the agent records what it EXPECTS (direction, target, time-to-target, max
 *    drawdown, confidence, expected behaviour). recordExpectation().
 *  - When the trade closes, the monitor folds in what ACTUALLY happened (duration, P/L, worst
 *    drawdown) into a single comparison record. recordOutcome().
 *  - Over time this becomes a real database of the agent's predictions vs outcomes, which
 *    findSimilarSetups() searches when a new trade is being considered ("I found 14 similar setups;
 *    9 hit target, 5 failed; average time to outcome 18 min").
 *
 * File-backed under DAVE_DATA_ROOT, same pattern as the other trading stores. Expectations and
 * completed comparisons are kept separately so an open trade's expectation survives until its close.
 */

export interface TradeExpectation {
  ticket: string;
  symbol: string;
  direction: "buy" | "sell";
  timeframe?: string;
  /** Free-text tags describing the setup, used for similarity (e.g. "liquidity-sweep", "OB-retest"). */
  setupTags?: string[];
  expectedTarget?: number;
  expectedTimeMinutes?: number;
  expectedMaxDrawdownPct?: number;
  confidence?: number;
  expectedBehavior?: string;
  recordedAt: number;
}

export interface TradeOutcome {
  ticket: string;
  symbol: string;
  direction: "buy" | "sell";
  timeframe?: string;
  setupTags?: string[];
  expected?: Omit<TradeExpectation, "ticket" | "symbol" | "direction" | "recordedAt">;
  actual: {
    durationMinutes: number;
    closePnl?: number;
    worstPnl?: number;
    closeReason?: string;
  };
  /** Did the original thesis play out? Explicit if the agent said so, otherwise inferred from P/L. */
  thesisCorrect: boolean;
  recordedAt: number;
}

export const MAX_RETAINED_OUTCOMES = 500;

function base(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId);
}
function expectationsPath(userId: string): string {
  return join(base(userId), "trade-expectations.json");
}
function outcomesPath(userId: string): string {
  return join(base(userId), "trade-outcomes.json");
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}
function writeJson(path: string, value: unknown): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

export class InvalidExpectationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "InvalidExpectationError";
  }
}

export function recordExpectation(
  userId: string,
  input: Omit<TradeExpectation, "recordedAt">
): TradeExpectation {
  if (!input.ticket || !input.symbol) throw new InvalidExpectationError("An expectation needs at least a ticket and a symbol.");
  if (input.direction !== "buy" && input.direction !== "sell") throw new InvalidExpectationError('direction must be "buy" or "sell".');
  const all = readJson<TradeExpectation[]>(expectationsPath(userId), []);
  const exp: TradeExpectation = { ...input, recordedAt: Date.now() };
  writeJson(expectationsPath(userId), [...all.filter((e) => e.ticket !== input.ticket), exp]);
  return exp;
}

export function getExpectation(userId: string, ticket: string): TradeExpectation | undefined {
  return readJson<TradeExpectation[]>(expectationsPath(userId), []).find((e) => e.ticket === ticket);
}

/**
 * Records the completed comparison for a ticket (idempotent: a second call for the same ticket
 * replaces the first). Pulls the stored expectation if there is one, and consumes it.
 */
export function recordOutcome(
  userId: string,
  input: {
    ticket: string;
    symbol: string;
    direction: "buy" | "sell";
    actual: TradeOutcome["actual"];
    thesisCorrect?: boolean;
  }
): TradeOutcome {
  const exp = getExpectation(userId, input.ticket);
  const thesisCorrect = input.thesisCorrect ?? (input.actual.closePnl !== undefined ? input.actual.closePnl > 0 : false);
  const outcome: TradeOutcome = {
    ticket: input.ticket,
    symbol: input.symbol,
    direction: input.direction,
    timeframe: exp?.timeframe,
    setupTags: exp?.setupTags,
    expected: exp
      ? {
          timeframe: exp.timeframe,
          setupTags: exp.setupTags,
          expectedTarget: exp.expectedTarget,
          expectedTimeMinutes: exp.expectedTimeMinutes,
          expectedMaxDrawdownPct: exp.expectedMaxDrawdownPct,
          confidence: exp.confidence,
          expectedBehavior: exp.expectedBehavior,
        }
      : undefined,
    actual: input.actual,
    thesisCorrect,
    recordedAt: Date.now(),
  };
  const all = readJson<TradeOutcome[]>(outcomesPath(userId), []).filter((o) => o.ticket !== input.ticket);
  const next = [...all, outcome].slice(-MAX_RETAINED_OUTCOMES);
  writeJson(outcomesPath(userId), next);
  // Consume the expectation so it doesn't linger.
  const exps = readJson<TradeExpectation[]>(expectationsPath(userId), []).filter((e) => e.ticket !== input.ticket);
  writeJson(expectationsPath(userId), exps);
  return outcome;
}

export function listOutcomes(userId: string): TradeOutcome[] {
  return readJson<TradeOutcome[]>(outcomesPath(userId), []);
}

/** Whether a recorded outcome counts as a win: real profit if we have it, else the thesis flag. */
function isWin(o: TradeOutcome): boolean {
  return o.actual.closePnl !== undefined ? o.actual.closePnl > 0 : o.thesisCorrect;
}

/**
 * How many trades in a row, ending with the most recent close, were wins. 0 if the last trade was a
 * loss. Drives the hot-hand warning (the trader: "after 3+ wins in a row, warn against oversizing").
 */
export function getWinStreak(userId: string): number {
  const outcomes = [...listOutcomes(userId)].sort((a, b) => a.recordedAt - b.recordedAt);
  let streak = 0;
  for (let i = outcomes.length - 1; i >= 0; i--) {
    if (isWin(outcomes[i])) streak++;
    else break;
  }
  return streak;
}

export interface SimilarSetupQuery {
  symbol: string;
  direction: "buy" | "sell";
  timeframe?: string;
  setupTags?: string[];
}

export interface SimilarSetupResult {
  count: number;
  hits: number;
  fails: number;
  avgTimeMinutes: number | undefined;
  hitRate: number | undefined;
  examples: { symbol: string; direction: string; thesisCorrect: boolean; durationMinutes: number; closePnl?: number }[];
}

/**
 * Finds past closed trades similar to a setup being considered. Similarity: same symbol AND same
 * direction is the base match; a matching timeframe or any overlapping setup tag strengthens it but
 * a bare symbol+direction match still counts, so the memory is useful from the very first trades.
 */
export function findSimilarSetups(userId: string, q: SimilarSetupQuery): SimilarSetupResult {
  const wantTags = new Set((q.setupTags ?? []).map((t) => t.toLowerCase()));
  const matches = listOutcomes(userId).filter((o) => {
    if (o.symbol !== q.symbol || o.direction !== q.direction) return false;
    // symbol+direction is enough; timeframe/tags only narrow if the caller supplied them AND the
    // record has them, so a record missing that metadata is never excluded on its absence.
    if (q.timeframe && o.timeframe && o.timeframe !== q.timeframe) return false;
    if (wantTags.size > 0 && o.setupTags && o.setupTags.length > 0) {
      const overlap = o.setupTags.some((t) => wantTags.has(t.toLowerCase()));
      if (!overlap) return false;
    }
    return true;
  });
  const hits = matches.filter((m) => m.thesisCorrect).length;
  const durations = matches.map((m) => m.actual.durationMinutes).filter((d) => Number.isFinite(d));
  const avg = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : undefined;
  return {
    count: matches.length,
    hits,
    fails: matches.length - hits,
    avgTimeMinutes: avg,
    hitRate: matches.length > 0 ? hits / matches.length : undefined,
    examples: matches.slice(-5).map((m) => ({ symbol: m.symbol, direction: m.direction, thesisCorrect: m.thesisCorrect, durationMinutes: m.actual.durationMinutes, closePnl: m.actual.closePnl })),
  };
}

/** Overall expected-vs-actual accuracy summary across all recorded outcomes. */
export function predictionAccuracySummary(userId: string): {
  total: number;
  thesisCorrect: number;
  thesisCorrectRate: number | undefined;
  withExpectation: number;
  avgExpectedMinutes: number | undefined;
  avgActualMinutes: number | undefined;
} {
  const outcomes = listOutcomes(userId);
  const withExp = outcomes.filter((o) => o.expected);
  const expMins = withExp.map((o) => o.expected?.expectedTimeMinutes).filter((n): n is number => typeof n === "number");
  const actMins = withExp.map((o) => o.actual.durationMinutes).filter((n) => Number.isFinite(n));
  const correct = outcomes.filter((o) => o.thesisCorrect).length;
  const mean = (xs: number[]) => (xs.length > 0 ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : undefined);
  return {
    total: outcomes.length,
    thesisCorrect: correct,
    thesisCorrectRate: outcomes.length > 0 ? correct / outcomes.length : undefined,
    withExpectation: withExp.length,
    avgExpectedMinutes: mean(expMins),
    avgActualMinutes: mean(actMins),
  };
}
