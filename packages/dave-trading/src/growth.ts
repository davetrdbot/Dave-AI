import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { getMinRiskReward, setMinRiskReward } from "./risk-reward-guard.js";
import { getConfidenceSettings, setConfidenceThreshold } from "./confidence-gate.js";

/**
 * Dave's self-improvement loop (the trader: "focus on the self improvement and give it what success
 * and failure is"; the pictures: "the scientific method -- change one variable at a time",
 * "Outcome -> Hypothesis -> Test -> Revise", a strategy card v03 with a "score vs goal").
 *
 * Three pieces, all plain files so the bot and the app read the same thing:
 *
 *   GOALS    -- what success and failure mean, in numbers the trader can edit.
 *   STRATEGY -- numbered versions (v01, v02...). Each new version changes exactly ONE variable
 *               from the last, runs for a test cycle of N closed trades, and is then scored
 *               against the goal: better -> it becomes the new baseline, worse -> the change is
 *               undone. Never two changes at once, or nobody can tell which one worked.
 *   NEURONS  -- the brain: one neuron per topic (RSI, MACD, volatility, zones, synthetics...), each
 *               holding the facts Dave has learned about it, strengthened when later trades agree
 *               and weakened when they don't.
 *
 * Safety: Dave may only TIGHTEN the trader's own numbers (a higher R:R floor, a higher confidence
 * bar), never loosen them below what the trader set. Written rules and "leave this pair alone"
 * are always allowed -- they only ever make him more careful.
 */

// ───────────────────────────── storage ─────────────────────────────

function dir(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "growth");
}
function readJson<T>(path: string, fallback: T): T {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    /* a broken file falls back to defaults */
  }
  return fallback;
}
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}
const newId = () => randomBytes(4).toString("hex");

// ───────────────────────────── goals ─────────────────────────────

export interface GrowthGoals {
  /** SUCCESS -- all of these met over the scoring window. */
  targetMonthlyReturnPct: number;
  minWinRatePct: number;
  minProfitFactor: number;
  /** FAILURE -- any one of these breached is a failure, whatever else looks good. */
  maxDrawdownPct: number;
  maxLosingStreak: number;
  maxDailyLossPct: number;
  /** Closed trades in one test cycle before a change is judged. */
  tradesPerCycle: number;
  /** Master switch: Dave runs the reflection loop and may change one setting at a time. */
  enabled: boolean;
}

export const DEFAULT_GOALS: GrowthGoals = {
  targetMonthlyReturnPct: 8,
  minWinRatePct: 45,
  minProfitFactor: 1.5,
  maxDrawdownPct: 10,
  maxLosingStreak: 5,
  maxDailyLossPct: 4,
  tradesPerCycle: 6,
  enabled: true,
};

const GOAL_BOUNDS: Record<keyof Omit<GrowthGoals, "enabled">, [number, number]> = {
  targetMonthlyReturnPct: [0.5, 200],
  minWinRatePct: [5, 95],
  minProfitFactor: [0.5, 10],
  maxDrawdownPct: [1, 80],
  maxLosingStreak: [2, 50],
  maxDailyLossPct: [0.5, 50],
  tradesPerCycle: [3, 50],
};

export function getGrowthGoals(userId: string): GrowthGoals {
  return { ...DEFAULT_GOALS, ...readJson<Partial<GrowthGoals>>(join(dir(userId), "goals.json"), {}) };
}

export function setGrowthGoals(userId: string, patch: Partial<GrowthGoals>): GrowthGoals {
  const next = getGrowthGoals(userId);
  for (const [k, v] of Object.entries(patch) as [keyof GrowthGoals, unknown][]) {
    if (k === "enabled") {
      if (typeof v === "boolean") next.enabled = v;
      continue;
    }
    if (!(k in GOAL_BOUNDS)) continue;
    const n = Number(v);
    const [lo, hi] = GOAL_BOUNDS[k as keyof typeof GOAL_BOUNDS];
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${k} must be between ${lo} and ${hi}`);
    (next as unknown as Record<string, number>)[k] = k === "maxLosingStreak" || k === "tradesPerCycle" ? Math.round(n) : n;
  }
  writeJson(join(dir(userId), "goals.json"), next);
  return next;
}

/** The plain-words definition, for Dave's prompt and the app. */
export function describeGoals(g: GrowthGoals): { success: string[]; failure: string[]; perTrade: { success: string[]; failure: string[] } } {
  return {
    success: [
      `making ${g.targetMonthlyReturnPct}% a month or better`,
      `winning at least ${g.minWinRatePct}% of trades`,
      `a profit factor of ${g.minProfitFactor} or more (money won ÷ money lost)`,
    ],
    failure: [
      `a drawdown deeper than ${g.maxDrawdownPct}% from the peak`,
      `${g.maxLosingStreak} losing trades in a row`,
      `losing more than ${g.maxDailyLossPct}% of the account in one day`,
    ],
    perTrade: {
      success: [
        "it hit its target, or was closed in profit on purpose",
        "a loss that hit the stop exactly where the plan said, at the planned size (a good loss: the process worked)",
        "a winner protected (breakeven / partial) before it could turn into a loser",
      ],
      failure: [
        "a loss bigger than the risk planned when it was opened",
        "a trade taken below your R:R floor, against a rule, or on a pair you were told to leave",
        "a winner that went back to a loss because nothing protected it",
        "a stop moved further away to avoid being hit",
      ],
    },
  };
}

// ───────────────────────────── scoring ─────────────────────────────

export interface ScoredTrade {
  pnl: number;
  closedAt: number;
  symbol?: string;
  reason?: string;
}

export interface GrowthMetrics {
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  profitFactor: number | null;
  netPnl: number;
  returnPct: number | null;
  monthlyReturnPct: number | null;
  maxDrawdownPct: number | null;
  longestLosingStreak: number;
  worstDayLossPct: number | null;
  days: number;
}

export interface GrowthScore {
  /** -1 (far from the goal) .. +1 (at or beyond it). */
  score: number;
  verdict: "success" | "on_track" | "off_track" | "failure" | "no_data";
  metrics: GrowthMetrics;
  /** One line per goal: met / missed, with the number. */
  checks: { goal: string; ok: boolean; kind: "success" | "failure"; value: string }[];
}

const clamp = (x: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);

export function computeGrowthMetrics(trades: ScoredTrade[], balance: number | undefined, now = Date.now()): GrowthMetrics {
  const sorted = [...trades].sort((a, b) => a.closedAt - b.closedAt);
  const wins = sorted.filter((t) => t.pnl > 0);
  const losses = sorted.filter((t) => t.pnl < 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.pnl, 0);
  const netPnl = grossWin - grossLoss;
  const first = sorted[0]?.closedAt ?? now;
  const days = Math.max(1, (now - first) / 86_400_000);
  // The balance NOW already contains the window's P&L -- the start of the window is what the
  // percentages are measured against.
  const start = balance !== undefined && balance > 0 ? balance - netPnl : undefined;
  let equity = start ?? 0;
  let peak = equity;
  let maxDd = 0;
  let streak = 0;
  let longest = 0;
  const perDay = new Map<string, number>();
  for (const t of sorted) {
    equity += t.pnl;
    peak = Math.max(peak, equity);
    if (start !== undefined && peak > 0) maxDd = Math.max(maxDd, (peak - equity) / peak);
    streak = t.pnl < 0 ? streak + 1 : 0;
    longest = Math.max(longest, streak);
    perDay.set(dayKey(t.closedAt), (perDay.get(dayKey(t.closedAt)) ?? 0) + t.pnl);
  }
  const worstDay = Math.min(0, ...perDay.values());
  const returnPct = start ? (netPnl / start) * 100 : null;
  return {
    trades: sorted.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: sorted.length ? (wins.length / sorted.length) * 100 : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : null,
    netPnl: Math.round(netPnl * 100) / 100,
    returnPct,
    // Short windows are projected cautiously: never more than 30 days of history is invented.
    monthlyReturnPct: returnPct === null ? null : (returnPct * 30) / Math.max(days, 7),
    maxDrawdownPct: start ? maxDd * 100 : null,
    longestLosingStreak: longest,
    worstDayLossPct: start ? (-worstDay / start) * 100 : null,
    days: Math.round(days * 10) / 10,
  };
}

export function scoreAgainstGoals(trades: ScoredTrade[], balance: number | undefined, goals: GrowthGoals, now = Date.now()): GrowthScore {
  const m = computeGrowthMetrics(trades, balance, now);
  if (!m.trades) return { score: 0, verdict: "no_data", metrics: m, checks: [] };
  const parts: number[] = [];
  const checks: GrowthScore["checks"] = [];
  const fmt = (n: number | null, d = 1, suffix = "") => (n === null ? "—" : `${n.toFixed(d)}${suffix}`);

  if (m.winRatePct !== null) {
    parts.push(clamp((m.winRatePct - goals.minWinRatePct) / Math.max(goals.minWinRatePct, 1)));
    checks.push({ goal: `win rate ≥ ${goals.minWinRatePct}%`, ok: m.winRatePct >= goals.minWinRatePct, kind: "success", value: fmt(m.winRatePct, 0, "%") });
  }
  if (m.profitFactor !== null) {
    parts.push(clamp((Math.min(m.profitFactor, 10) - goals.minProfitFactor) / goals.minProfitFactor));
    checks.push({ goal: `profit factor ≥ ${goals.minProfitFactor}`, ok: m.profitFactor >= goals.minProfitFactor, kind: "success", value: fmt(Math.min(m.profitFactor, 99), 2) });
  }
  if (m.monthlyReturnPct !== null) {
    parts.push(clamp((m.monthlyReturnPct - goals.targetMonthlyReturnPct) / goals.targetMonthlyReturnPct));
    checks.push({ goal: `${goals.targetMonthlyReturnPct}% a month`, ok: m.monthlyReturnPct >= goals.targetMonthlyReturnPct, kind: "success", value: fmt(m.monthlyReturnPct, 1, "%") });
  }
  let failed = false;
  if (m.maxDrawdownPct !== null) {
    parts.push(clamp(1 - (2 * m.maxDrawdownPct) / goals.maxDrawdownPct));
    const ok = m.maxDrawdownPct <= goals.maxDrawdownPct;
    failed ||= !ok;
    checks.push({ goal: `drawdown under ${goals.maxDrawdownPct}%`, ok, kind: "failure", value: fmt(m.maxDrawdownPct, 1, "%") });
  }
  {
    const ok = m.longestLosingStreak < goals.maxLosingStreak;
    failed ||= !ok;
    checks.push({ goal: `fewer than ${goals.maxLosingStreak} losses in a row`, ok, kind: "failure", value: String(m.longestLosingStreak) });
  }
  if (m.worstDayLossPct !== null) {
    const ok = m.worstDayLossPct <= goals.maxDailyLossPct;
    failed ||= !ok;
    checks.push({ goal: `no day worse than -${goals.maxDailyLossPct}%`, ok, kind: "failure", value: fmt(-m.worstDayLossPct, 1, "%") });
  }
  let score = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : m.netPnl > 0 ? 0.2 : -0.2;
  if (failed) score = Math.min(score, -0.5);
  score = Math.round(clamp(score) * 100) / 100;
  const successOk = checks.filter((c) => c.kind === "success").every((c) => c.ok);
  const verdict = failed ? "failure" : successOk ? "success" : score >= 0 ? "on_track" : "off_track";
  return { score, verdict, metrics: m, checks };
}

// ───────────────────────────── strategy versions ─────────────────────────────

export type GrowthVariable = "min_rr" | "min_confidence" | "add_rule" | "remove_rule" | "avoid_symbol" | "allow_symbol";

export const GROWTH_VARIABLES: { id: GrowthVariable; label: string; explain: string }[] = [
  { id: "min_rr", label: "Minimum risk:reward", explain: "the R:R floor every trade must clear (Dave can only raise it above what you set)" },
  { id: "min_confidence", label: "Confidence bar", explain: "the confidence a setup needs (Dave can only raise it above what you set)" },
  { id: "add_rule", label: "New written rule", explain: "a rule Dave follows on every scan, e.g. 'no gold entries in the first 15 min of London'" },
  { id: "remove_rule", label: "Drop a rule", explain: "remove a rule an earlier version added" },
  { id: "avoid_symbol", label: "Leave a pair alone", explain: "stop trading one pair that keeps losing" },
  { id: "allow_symbol", label: "Bring a pair back", explain: "trade a pair again that an earlier version benched" },
];

export interface StrategyChange {
  variable: GrowthVariable;
  from: string | number | null;
  to: string | number | null;
}

export interface StrategyVersion {
  v: number;
  createdAt: number;
  status: "baseline" | "testing" | "kept" | "reverted" | "interrupted";
  change?: StrategyChange;
  /** Why: what the last cycle's outcome showed. */
  outcome?: string;
  hypothesis?: string;
  /** Score of the cycle before the change -- the bar this version has to beat. */
  baselineScore?: number;
  /** Score of this version's own test cycle, once judged. */
  score?: number;
  judgedAt?: number;
  verdictNote?: string;
  /** Closed trades seen when the version started -- the test cycle counts from here. */
  startedAtTrade: number;
  startedAt: number;
}

export interface StrategyState {
  versions: StrategyVersion[];
  rules: { id: string; text: string; addedInV: number }[];
  avoidSymbols: { symbol: string; addedInV: number }[];
  /** The trader's own numbers when the loop started -- Dave never goes below these. */
  floors: { minRiskReward: number; minConfidence: number };
  cycle: number;
  lastReflectionAt?: number;
  lastReflectionTrades?: number;
}

function strategyPath(userId: string) {
  return join(dir(userId), "strategy.json");
}

export function getStrategyState(userId: string, now = Date.now()): StrategyState {
  const s = readJson<StrategyState | null>(strategyPath(userId), null);
  if (s) return s;
  const fresh: StrategyState = {
    versions: [{ v: 1, createdAt: now, status: "baseline", startedAtTrade: 0, startedAt: 0, outcome: "Starting point: your own settings." }],
    rules: [],
    avoidSymbols: [],
    floors: { minRiskReward: getMinRiskReward(userId), minConfidence: getConfidenceSettings(userId).threshold },
    cycle: 1,
  };
  writeJson(strategyPath(userId), fresh);
  return fresh;
}

export function saveStrategyState(userId: string, s: StrategyState): void {
  writeJson(strategyPath(userId), s);
}

export function currentVersion(s: StrategyState): StrategyVersion {
  return s.versions[s.versions.length - 1];
}

export function isAvoidedByStrategy(userId: string, symbol: string): boolean {
  const s = readJson<StrategyState | null>(strategyPath(userId), null);
  return !!s?.avoidSymbols.some((a) => a.symbol.toUpperCase() === symbol.toUpperCase());
}

/** What each variable is set to right now. */
export function currentVariableValue(userId: string, s: StrategyState, variable: GrowthVariable): string | number | null {
  if (variable === "min_rr") return getMinRiskReward(userId);
  if (variable === "min_confidence") return getConfidenceSettings(userId).threshold;
  return null;
}

/** Checks a proposed change and returns it normalised, or throws a plain-words reason. */
export function validateChange(userId: string, s: StrategyState, variable: string, to: unknown): StrategyChange {
  const v = variable as GrowthVariable;
  if (v === "min_rr") {
    const cur = getMinRiskReward(userId);
    const n = Math.round(Number(to) * 100) / 100;
    if (!Number.isFinite(n)) throw new Error("min_rr needs a number");
    if (n < s.floors.minRiskReward) throw new Error(`min_rr can't go below the trader's own ${s.floors.minRiskReward}`);
    if (n > 6) throw new Error("min_rr above 6 would stop nearly every trade");
    if (Math.abs(n - cur) > 1) throw new Error("move min_rr by at most 1 per version");
    if (n === cur) throw new Error("min_rr is already that");
    return { variable: v, from: cur, to: n };
  }
  if (v === "min_confidence") {
    const cur = getConfidenceSettings(userId).threshold;
    const n = Math.round(Number(to));
    if (!Number.isFinite(n)) throw new Error("min_confidence needs a number");
    if (n < s.floors.minConfidence) throw new Error(`min_confidence can't go below the trader's own ${s.floors.minConfidence}`);
    if (n > 95) throw new Error("min_confidence above 95 would stop nearly every trade");
    if (Math.abs(n - cur) > 10) throw new Error("move min_confidence by at most 10 per version");
    if (n === cur) throw new Error("min_confidence is already that");
    return { variable: v, from: cur, to: n };
  }
  if (v === "add_rule") {
    const text = String(to ?? "").replace(/\s+/g, " ").trim();
    if (text.length < 8 || text.length > 240) throw new Error("a rule is one clear sentence (8-240 characters)");
    if (s.rules.length >= 12) throw new Error("already 12 rules -- drop one first (remove_rule)");
    if (s.rules.some((r) => r.text.toLowerCase() === text.toLowerCase())) throw new Error("that rule already exists");
    return { variable: v, from: null, to: text };
  }
  if (v === "remove_rule") {
    const key = String(to ?? "").trim().toLowerCase();
    const rule = s.rules.find((r) => r.id === key || r.text.toLowerCase() === key);
    if (!rule) throw new Error("no such rule -- give its id");
    return { variable: v, from: rule.text, to: rule.id };
  }
  if (v === "avoid_symbol" || v === "allow_symbol") {
    const sym = String(to ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9._\- ]{2,30}$/.test(sym)) throw new Error("give the pair's symbol");
    const avoided = s.avoidSymbols.some((a) => a.symbol === sym);
    if (v === "avoid_symbol" && avoided) throw new Error(`${sym} is already avoided`);
    if (v === "allow_symbol" && !avoided) throw new Error(`${sym} isn't avoided`);
    return { variable: v, from: v === "allow_symbol" ? sym : null, to: sym };
  }
  throw new Error(`unknown variable ${variable} -- one of ${GROWTH_VARIABLES.map((x) => x.id).join(", ")}`);
}

/** Puts a change into effect (or undoes one, with `undo`). */
export function applyChange(userId: string, s: StrategyState, c: StrategyChange, version: number, undo = false): void {
  if (c.variable === "min_rr") setMinRiskReward(userId, Number(undo ? c.from : c.to));
  else if (c.variable === "min_confidence") setConfidenceThreshold(userId, Number(undo ? c.from : c.to));
  else if (c.variable === "add_rule") {
    if (undo) s.rules = s.rules.filter((r) => r.text !== c.to);
    else s.rules.push({ id: `r${newId().slice(0, 4)}`, text: String(c.to), addedInV: version });
  } else if (c.variable === "remove_rule") {
    if (undo) s.rules.push({ id: String(c.to), text: String(c.from), addedInV: version });
    else s.rules = s.rules.filter((r) => r.id !== c.to);
  } else if (c.variable === "avoid_symbol") {
    if (undo) s.avoidSymbols = s.avoidSymbols.filter((a) => a.symbol !== c.to);
    else s.avoidSymbols.push({ symbol: String(c.to), addedInV: version });
  } else if (c.variable === "allow_symbol") {
    if (undo) s.avoidSymbols.push({ symbol: String(c.to), addedInV: version });
    else s.avoidSymbols = s.avoidSymbols.filter((a) => a.symbol !== c.to);
  }
}

/** Is the change still in place? (The trader may have changed the same setting by hand.) */
export function changeStillInPlace(userId: string, s: StrategyState, c: StrategyChange): boolean {
  if (c.variable === "min_rr") return getMinRiskReward(userId) === Number(c.to);
  if (c.variable === "min_confidence") return getConfidenceSettings(userId).threshold === Number(c.to);
  return true;
}

export function describeChange(c: StrategyChange): string {
  switch (c.variable) {
    case "min_rr":
      return `min R:R ${c.from} → ${c.to}`;
    case "min_confidence":
      return `confidence bar ${c.from}% → ${c.to}%`;
    case "add_rule":
      return `new rule: "${c.to}"`;
    case "remove_rule":
      return `dropped rule: "${c.from}"`;
    case "avoid_symbol":
      return `leave ${c.to} alone`;
    case "allow_symbol":
      return `trade ${c.to} again`;
  }
}

// ───────────────────────────── neurons (the brain) ─────────────────────────────

export interface NeuronFact {
  id: string;
  text: string;
  evidence?: string;
  /** 1 (a hunch) .. 5 (proven many times). */
  strength: number;
  confirmations: number;
  contradictions: number;
  source: "reflection" | "dave" | "trader";
  createdAt: number;
  updatedAt: number;
}

export interface Neuron {
  id: string;
  label: string;
  emoji: string;
  facts: NeuronFact[];
}

export const DEFAULT_NEURONS: { id: string; label: string; emoji: string }[] = [
  { id: "rsi", label: "RSI", emoji: "📈" },
  { id: "macd", label: "MACD", emoji: "〰️" },
  { id: "volatility", label: "Volatility", emoji: "🌊" },
  { id: "zones", label: "Zones", emoji: "🧱" },
  { id: "structure", label: "Structure", emoji: "🏗️" },
  { id: "trend", label: "Trend", emoji: "🧭" },
  { id: "momentum", label: "Momentum", emoji: "⚡" },
  { id: "liquidity", label: "Liquidity", emoji: "💧" },
  { id: "sessions", label: "Sessions", emoji: "🕐" },
  { id: "synthetic", label: "Synthetics", emoji: "🧪" },
  { id: "news", label: "News", emoji: "📰" },
  { id: "risk", label: "Risk", emoji: "🛡️" },
  { id: "execution", label: "Execution", emoji: "🎯" },
  { id: "psychology", label: "Psychology", emoji: "🧠" },
];

const MAX_FACTS_PER_NEURON = 30;

function neuronsPath(userId: string) {
  return join(dir(userId), "neurons.json");
}

export function listNeurons(userId: string): Neuron[] {
  const stored = readJson<Neuron[]>(neuronsPath(userId), []);
  const byId = new Map(stored.map((n) => [n.id, n]));
  const out: Neuron[] = DEFAULT_NEURONS.map((d) => byId.get(d.id) ?? { ...d, facts: [] });
  for (const n of stored) if (!DEFAULT_NEURONS.some((d) => d.id === n.id)) out.push(n);
  return out;
}

function saveNeurons(userId: string, neurons: Neuron[]): void {
  writeJson(neuronsPath(userId), neurons);
}

export function neuronSlug(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24);
}

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9%.]+/g, " ").trim();

function similar(a: string, b: string): boolean {
  const A = new Set(norm(a).split(" ").filter((w) => w.length > 2));
  const B = new Set(norm(b).split(" ").filter((w) => w.length > 2));
  if (!A.size || !B.size) return false;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / Math.min(A.size, B.size) >= 0.8;
}

/** Stores a fact in a neuron. A fact it already knows is confirmed (made stronger) instead of
 *  duplicated. Returns the fact and whether it was new. */
export function learnFact(
  userId: string,
  neuron: string,
  text: string,
  opts: { evidence?: string; source?: NeuronFact["source"]; strength?: number } = {},
  now = Date.now()
): { neuron: string; fact: NeuronFact; isNew: boolean } {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length < 6 || clean.length > 400) throw new Error("a fact is one sentence (6-400 characters)");
  const id = neuronSlug(neuron);
  if (!id) throw new Error("name the neuron (e.g. rsi, volatility, zones)");
  const all = listNeurons(userId);
  let n = all.find((x) => x.id === id);
  if (!n) {
    n = { id, label: neuron.trim().slice(0, 24), emoji: "✨", facts: [] };
    all.push(n);
  }
  const existing = n.facts.find((f) => similar(f.text, clean));
  if (existing) {
    existing.confirmations++;
    existing.strength = Math.min(5, existing.strength + 1);
    existing.updatedAt = now;
    if (opts.evidence) existing.evidence = opts.evidence.slice(0, 400);
    saveNeurons(userId, all);
    return { neuron: n.id, fact: existing, isNew: false };
  }
  const fact: NeuronFact = {
    id: `${n.id}-${newId()}`,
    text: clean,
    evidence: opts.evidence?.slice(0, 400),
    strength: Math.max(1, Math.min(5, Math.round(opts.strength ?? 2))),
    confirmations: 0,
    contradictions: 0,
    source: opts.source ?? "dave",
    createdAt: now,
    updatedAt: now,
  };
  n.facts.push(fact);
  if (n.facts.length > MAX_FACTS_PER_NEURON) {
    // Forget the weakest, oldest fact first.
    n.facts.sort((a, b) => b.strength - a.strength || b.updatedAt - a.updatedAt);
    n.facts = n.facts.slice(0, MAX_FACTS_PER_NEURON);
  }
  saveNeurons(userId, all);
  return { neuron: n.id, fact, isNew: true };
}

/** A later outcome agreed (supports) or disagreed with a fact. A fact contradicted down to zero is
 *  forgotten. */
export function reinforceFact(userId: string, factId: string, supports: boolean, now = Date.now()): NeuronFact | null {
  const all = listNeurons(userId);
  for (const n of all) {
    const f = n.facts.find((x) => x.id === factId);
    if (!f) continue;
    if (supports) {
      f.confirmations++;
      f.strength = Math.min(5, f.strength + 1);
    } else {
      f.contradictions++;
      f.strength -= 1;
    }
    f.updatedAt = now;
    if (f.strength <= 0) n.facts = n.facts.filter((x) => x.id !== factId);
    saveNeurons(userId, all);
    return f.strength > 0 ? f : null;
  }
  return null;
}

export function forgetFact(userId: string, factId: string): boolean {
  const all = listNeurons(userId);
  for (const n of all) {
    const before = n.facts.length;
    n.facts = n.facts.filter((f) => f.id !== factId);
    if (n.facts.length !== before) {
      saveNeurons(userId, all);
      return true;
    }
  }
  return false;
}

/** The strongest facts across the brain, for a prompt. */
export function topFacts(userId: string, max = 12, onlyNeurons?: string[]): { neuron: string; fact: NeuronFact }[] {
  return listNeurons(userId)
    .filter((n) => !onlyNeurons || onlyNeurons.includes(n.id))
    .flatMap((n) => n.facts.map((fact) => ({ neuron: n.label, fact })))
    .sort((a, b) => b.fact.strength - a.fact.strength || b.fact.updatedAt - a.fact.updatedAt)
    .slice(0, max);
}

// ───────────────────────────── the block Dave sees ─────────────────────────────

/** Compact: the goal, the current strategy card, the rules, and what the brain knows. */
export function growthContextBlock(userId: string, score?: GrowthScore, maxFacts = 10): string | null {
  const goals = getGrowthGoals(userId);
  if (!goals.enabled) return null;
  const s = getStrategyState(userId);
  const v = currentVersion(s);
  const d = describeGoals(goals);
  const lines = [
    `YOUR GOAL (the trader defined it): SUCCESS = ${d.success.join("; ")}. FAILURE = ${d.failure.join("; ")}.`,
    `STRATEGY CARD v${String(v.v).padStart(2, "0")} (${v.status}${v.change ? `: ${describeChange(v.change)}` : ""})${score && score.verdict !== "no_data" ? ` -- score vs goal ${score.score >= 0 ? "+" : ""}${score.score.toFixed(2)}, ${score.verdict.replace("_", " ")}` : ""}.`,
  ];
  if (v.status === "testing" && v.hypothesis) lines.push(`Testing now: ${v.hypothesis} Play this version straight so the test means something.`);
  if (s.rules.length) lines.push(`YOUR RULES (follow every one): ${s.rules.map((r) => `[${r.id}] ${r.text}`).join(" | ")}`);
  if (s.avoidSymbols.length) lines.push(`Pairs you decided to leave alone: ${s.avoidSymbols.map((a) => a.symbol).join(", ")}.`);
  const facts = topFacts(userId, maxFacts);
  if (facts.length) lines.push(`WHAT YOUR BRAIN HAS LEARNED (strongest first): ${facts.map((f) => `${f.neuron}: ${f.fact.text} (${"●".repeat(f.fact.strength)})`).join(" | ")}`);
  return lines.join("\n");
}
