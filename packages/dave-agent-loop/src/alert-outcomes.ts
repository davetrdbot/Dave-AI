import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TradeMonitor } from "./trade-monitor-store.js";

/**
 * The self-aware monitor's memory: what actually happened to trades after each kind of alert, and
 * after each verdict Dave gave on them. "Losing for 10 minutes" means something very different if
 * 7 of the last 10 such trades still closed green than if 9 of 10 hit the stop -- and until now
 * nothing kept that record, so every alert was judged from scratch.
 */

export interface AlertOutcome {
  /** An alert kind ("loss10m", "range", ...) or a verdict ("verdict:HOLD", "verdict:CLOSE", ...). */
  kind: string;
  ticket: string;
  symbol: string;
  firedAt: number;
  pnlAtAlert?: number;
  finalPnl: number;
  closedAt: number;
}

const KEEP = 1500;
const MIN_FOR_STATS = 5;

function path(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "alert-outcomes.json");
}

export function listAlertOutcomes(userId: string): AlertOutcome[] {
  try {
    if (existsSync(path(userId))) return JSON.parse(readFileSync(path(userId), "utf8")) as AlertOutcome[];
  } catch {
    /* a broken file starts over */
  }
  return [];
}

function save(userId: string, list: AlertOutcome[]): void {
  mkdirSync(dirname(path(userId)), { recursive: true });
  writeFileSync(path(userId), JSON.stringify(list.slice(-KEEP)), "utf8");
}

/** Pending verdicts per ticket, written when Dave reviews a trade and settled when it closes. */
function verdictsPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "self-aware-verdicts.json");
}

export interface PendingVerdict {
  ticket: string;
  symbol: string;
  verdict: string;
  at: number;
  pnl?: number;
}

export function recordVerdict(userId: string, v: PendingVerdict): void {
  let list: PendingVerdict[] = [];
  try {
    if (existsSync(verdictsPath(userId))) list = JSON.parse(readFileSync(verdictsPath(userId), "utf8")) as PendingVerdict[];
  } catch {
    list = [];
  }
  list.push(v);
  mkdirSync(dirname(verdictsPath(userId)), { recursive: true });
  writeFileSync(verdictsPath(userId), JSON.stringify(list.slice(-300)), "utf8");
}

/**
 * A trade closed: every alert kind that fired on it (first firing of each) and every verdict given
 * on it become outcomes. Called once per close by the sweep.
 */
export function recordTradeClosed(userId: string, m: TradeMonitor, now = Date.now()): number {
  if (m.lastPnl === undefined) return 0;
  const finalPnl = m.lastPnl;
  const seen = new Set<string>();
  const add: AlertOutcome[] = [];
  for (const f of m.fired ?? []) {
    if (seen.has(f.kind)) continue;
    seen.add(f.kind);
    add.push({ kind: f.kind, ticket: m.ticket, symbol: m.symbol, firedAt: f.at, pnlAtAlert: f.pnl, finalPnl, closedAt: now });
  }
  let verdicts: PendingVerdict[] = [];
  try {
    if (existsSync(verdictsPath(userId))) verdicts = JSON.parse(readFileSync(verdictsPath(userId), "utf8")) as PendingVerdict[];
  } catch {
    verdicts = [];
  }
  const mine = verdicts.filter((v) => v.ticket === m.ticket);
  for (const v of mine) add.push({ kind: `verdict:${v.verdict}`, ticket: m.ticket, symbol: m.symbol, firedAt: v.at, pnlAtAlert: v.pnl, finalPnl, closedAt: now });
  if (mine.length) {
    mkdirSync(dirname(verdictsPath(userId)), { recursive: true });
    writeFileSync(verdictsPath(userId), JSON.stringify(verdicts.filter((v) => v.ticket !== m.ticket)), "utf8");
  }
  if (add.length) save(userId, [...listAlertOutcomes(userId), ...add]);
  return add.length;
}

export interface AlertKindStats {
  kind: string;
  n: number;
  /** Trades that still closed in profit after this alert. */
  closedGreen: number;
  closedGreenPct: number;
  /** Closed better than the P/L at the moment of the alert (holding paid). */
  improvedPct: number;
  avgFinalPnl: number;
  /** Average of (final - at alert): what holding from the alert was worth. */
  avgChangeAfter: number;
}

export function alertKindStats(userId: string, kind: string, sinceMs = 90 * 86_400_000, now = Date.now()): AlertKindStats | null {
  const rows = listAlertOutcomes(userId).filter((o) => o.kind === kind && now - o.closedAt <= sinceMs);
  if (!rows.length) return null;
  const green = rows.filter((o) => o.finalPnl > 0).length;
  const withAt = rows.filter((o) => typeof o.pnlAtAlert === "number");
  const improved = withAt.filter((o) => o.finalPnl > (o.pnlAtAlert as number)).length;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    kind,
    n: rows.length,
    closedGreen: green,
    closedGreenPct: Math.round((green / rows.length) * 100),
    improvedPct: withAt.length ? Math.round((improved / withAt.length) * 100) : 0,
    avgFinalPnl: r2(rows.reduce((a, o) => a + o.finalPnl, 0) / rows.length),
    avgChangeAfter: withAt.length ? r2(withAt.reduce((a, o) => a + (o.finalPnl - (o.pnlAtAlert as number)), 0) / withAt.length) : 0,
  };
}

export function allAlertStats(userId: string, now = Date.now()): AlertKindStats[] {
  const kinds = [...new Set(listAlertOutcomes(userId).map((o) => o.kind))];
  return kinds
    .map((k) => alertKindStats(userId, k, undefined, now))
    .filter((x): x is AlertKindStats => !!x)
    .sort((a, b) => b.n - a.n);
}

const money = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(2)}`;

/** One line for an alert: what usually happened next. Null until there's enough history. */
export function outcomeLine(userId: string, kind: string, now = Date.now()): string | null {
  const s = alertKindStats(userId, kind, undefined, now);
  if (!s || s.n < MIN_FOR_STATS) return null;
  return `📚 Your history: of the last ${s.n} trades that hit this, ${s.closedGreen} still closed green (${s.closedGreenPct}%); holding from here averaged ${money(s.avgChangeAfter)}.`;
}

/** The chat tool: what the monitor has learned about its own alerts and Dave's verdicts. */
export function createSelfAwareStatsTool(userId: string, getMode: () => string) {
  return {
    name: "self_aware_stats",
    description:
      "What your self-aware monitor has learned: for each alert kind (loss10m, range, roundTrip, neverGreen, racing...) and each of your review verdicts (verdict:HOLD, verdict:CLOSE...), " +
      "how many trades hit it, how many still closed green, and what holding from that moment was worth on average. Plus the review mode (off / advise / act). " +
      "Use it before arguing to hold or cut a trade on an alert, and when the trader asks how the self-aware system is doing.",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const stats = allAlertStats(userId);
      return {
        mode: getMode(),
        alerts: stats.filter((s) => !s.kind.startsWith("verdict:")),
        verdicts: stats.filter((s) => s.kind.startsWith("verdict:")).map((s) => ({ ...s, kind: s.kind.slice(8) })),
        note: stats.length ? undefined : "Nothing learned yet -- outcomes are recorded as trades that raised alerts close.",
      };
    },
  };
}
