import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Grading Dave's calls against what price did next -- the skips as much as the trades.
 *
 * Every scan decision (SKIP, BUY, SELL, a pending order) is written down as PENDING. Once its
 * window has passed (2 hours by default), the candles since the decision say what a clean trade
 * would have done: a target of `rr` x ATR against a stop of 1 x ATR, whichever came first.
 *
 *   SKIP  -> "good skip" (neither side would have paid) or "missed long/short" (one side ran)
 *   BUY/SELL/limit -> "good call", "bad call" (stop first) or "flat" (neither within the window)
 *
 * The misses and bad calls are the ones worth a lesson; they are reflected on and filed into the
 * brain. The last few grades for a pair come back to Dave on his next scan of it.
 */

export type GradeVerdict = "good_skip" | "missed_long" | "missed_short" | "good_call" | "bad_call" | "flat";

export interface GradedDecision {
  id: string;
  at: number;
  symbol: string;
  /** SKIP, BUY, SELL, BUY_LIMIT, ... */
  action: string;
  direction: "long" | "short" | null;
  reason: string;
  confidence?: number;
  status: "pending" | "settled" | "expired";
  settledAt?: number;
  verdict?: GradeVerdict;
  /** How far price went each way within the window, in ATRs. */
  upAtr?: number;
  downAtr?: number;
  rr?: number;
  refPrice?: number;
  /** The short lesson, when this one earned one. */
  lesson?: string;
  neuron?: string;
}

export const GRADE_WINDOW_MS = 2 * 3_600_000;
const DEDUPE_MS = 30 * 60_000;
const KEEP = 600;

function path(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "growth", "graded-calls.json");
}

export function listGradedDecisions(userId: string): GradedDecision[] {
  try {
    if (existsSync(path(userId))) return JSON.parse(readFileSync(path(userId), "utf8")) as GradedDecision[];
  } catch {
    /* a broken file starts over */
  }
  return [];
}

function save(userId: string, list: GradedDecision[]): void {
  mkdirSync(dirname(path(userId)), { recursive: true });
  writeFileSync(path(userId), JSON.stringify(list.slice(-KEEP)), "utf8");
}

const directionOf = (action: string): "long" | "short" | null => (/^BUY/.test(action) ? "long" : /^SELL/.test(action) ? "short" : null);

/** Writes a scan decision down to be graded later. One per pair per half hour -- a pair scanned
 *  every few minutes and skipped each time is one call, not twelve. */
export function recordDecisionForGrading(userId: string, d: { symbol: string; action: string; reason: string; confidence?: number }, now = Date.now()): GradedDecision | null {
  const action = d.action.toUpperCase();
  if (action !== "SKIP" && !directionOf(action)) return null;
  const list = listGradedDecisions(userId);
  const sym = d.symbol.toUpperCase();
  const recent = [...list].reverse().find((x) => x.symbol === sym && now - x.at < DEDUPE_MS);
  // A trade after earlier skips on the same pair is still recorded: the entry is the call that matters.
  if (recent && (action === "SKIP" || recent.action === action)) return null;
  const entry: GradedDecision = {
    id: randomBytes(5).toString("hex"),
    at: now,
    symbol: sym,
    action,
    direction: directionOf(action),
    reason: d.reason.replace(/\s+/g, " ").slice(0, 400),
    confidence: d.confidence,
    status: "pending",
  };
  list.push(entry);
  save(userId, list);
  return entry;
}

export interface GradeBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

/**
 * The verdict for one decision from the bars around it. `bars` oldest first; `atr` in price.
 * Returns null when the bars don't cover the window yet (or at all).
 */
export function gradeDecision(
  d: Pick<GradedDecision, "at" | "action" | "direction">,
  bars: GradeBar[],
  atr: number,
  rr: number,
  barMs: number,
  windowMs = GRADE_WINDOW_MS
): Pick<GradedDecision, "verdict" | "upAtr" | "downAtr" | "refPrice" | "rr"> | null {
  if (!(atr > 0) || !bars.length) return null;
  const sorted = [...bars].sort((a, b) => a.t - b.t);
  const decisionBar = sorted.find((b) => b.t <= d.at && d.at < b.t + barMs);
  const after = sorted.filter((b) => b.t > d.at && b.t < d.at + windowMs);
  const last = sorted[sorted.length - 1];
  if (!decisionBar || !after.length || last.t + barMs < d.at + windowMs) return null;
  const ref = decisionBar.c;
  const target = rr * atr;
  // Walk forward bar by bar: which side reached its target / stop first.
  let longWin: boolean | null = null;
  let shortWin: boolean | null = null;
  let up = 0;
  let down = 0;
  for (const b of after) {
    up = Math.max(up, b.h - ref);
    down = Math.max(down, ref - b.l);
    // Inside one bar we can't know the order -- the stop is assumed first (the honest, harsh read).
    if (longWin === null) {
      if (b.l <= ref - atr) longWin = false;
      else if (b.h >= ref + target) longWin = true;
    }
    if (shortWin === null) {
      if (b.h >= ref + atr) shortWin = false;
      else if (b.l <= ref - target) shortWin = true;
    }
  }
  const r2 = (n: number) => Math.round((n / atr) * 100) / 100;
  let verdict: GradeVerdict;
  if (d.direction === null) {
    verdict = longWin ? "missed_long" : shortWin ? "missed_short" : "good_skip";
  } else {
    const win = d.direction === "long" ? longWin : shortWin;
    verdict = win === true ? "good_call" : win === false ? "bad_call" : "flat";
  }
  return { verdict, upAtr: r2(up), downAtr: r2(down), refPrice: ref, rr };
}

export function settleDecision(userId: string, id: string, patch: Partial<GradedDecision>, now = Date.now()): void {
  const list = listGradedDecisions(userId);
  const d = list.find((x) => x.id === id);
  if (!d) return;
  Object.assign(d, patch, { settledAt: now });
  save(userId, list);
}

export function pendingDueDecisions(userId: string, now = Date.now(), windowMs = GRADE_WINDOW_MS): GradedDecision[] {
  return listGradedDecisions(userId).filter((d) => d.status === "pending" && now - d.at >= windowMs + 5 * 60_000);
}

export function describeVerdict(d: GradedDecision): string {
  const r = d.rr ?? 2;
  switch (d.verdict) {
    case "good_skip":
      return "good skip -- neither side paid";
    case "missed_long":
      return `missed a long -- price ran +${r}R before a 1R stop`;
    case "missed_short":
      return `missed a short -- price fell ${r}R before a 1R stop`;
    case "good_call":
      return `good call -- reached ${r}R before the stop`;
    case "bad_call":
      return "bad call -- hit a 1R stop first";
    case "flat":
      return "flat -- neither target nor stop in 2h";
    default:
      return d.status;
  }
}

export interface GradeStats {
  graded: number;
  skips: number;
  goodSkips: number;
  missed: number;
  calls: number;
  goodCalls: number;
  badCalls: number;
  /** Share of skips that were right, 0-100. */
  skipAccuracyPct: number | null;
  /** Share of taken calls that reached target before stop (flat excluded), 0-100. */
  callAccuracyPct: number | null;
}

export function gradeStats(userId: string, sinceMs = 30 * 86_400_000, now = Date.now()): GradeStats {
  const s = listGradedDecisions(userId).filter((d) => d.status === "settled" && now - d.at <= sinceMs);
  const skips = s.filter((d) => d.direction === null);
  const calls = s.filter((d) => d.direction !== null);
  const goodSkips = skips.filter((d) => d.verdict === "good_skip").length;
  const goodCalls = calls.filter((d) => d.verdict === "good_call").length;
  const badCalls = calls.filter((d) => d.verdict === "bad_call").length;
  return {
    graded: s.length,
    skips: skips.length,
    goodSkips,
    missed: skips.length - goodSkips,
    calls: calls.length,
    goodCalls,
    badCalls,
    skipAccuracyPct: skips.length ? Math.round((goodSkips / skips.length) * 100) : null,
    callAccuracyPct: goodCalls + badCalls ? Math.round((goodCalls / (goodCalls + badCalls)) * 100) : null,
  };
}

/** What Dave sees when he scans a pair again: his last graded calls on it, and a few lessons from
 *  other pairs. Null when there's nothing graded yet. */
export function pastCallsBlock(userId: string, symbol: string, nSame = 5, nCross = 3): string | null {
  const settled = listGradedDecisions(userId).filter((d) => d.status === "settled").reverse();
  const sym = symbol.toUpperCase();
  const same = settled.filter((d) => d.symbol === sym).slice(0, nSame);
  const cross = settled.filter((d) => d.symbol !== sym && d.lesson).slice(0, nCross);
  if (!same.length && !cross.length) return null;
  const ago = (t: number) => `${Math.max(1, Math.round((Date.now() - t) / 3_600_000))}h ago`;
  const lines = [`YOUR LAST CALLS ON ${sym}, graded against what price did next (2h window, 1 ATR stop, ${same[0]?.rr ?? 2}R target):`];
  for (const d of same) lines.push(`- ${ago(d.at)} ${d.action}: ${describeVerdict(d)} (up ${d.upAtr} / down ${d.downAtr} ATR).${d.lesson ? ` Lesson: ${d.lesson}` : ""}`);
  if (cross.length) {
    lines.push("Lessons from other pairs:");
    for (const d of cross) lines.push(`- ${d.symbol} ${d.action}: ${d.lesson}`);
  }
  lines.push("A run of 'missed' on a pair means your filter is too strict there; a run of 'bad call' means it's too loose. Adjust, don't repeat.");
  return lines.join("\n");
}
