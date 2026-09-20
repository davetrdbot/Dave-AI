import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The Self-Aware Trade Monitor's per-ticket record and pure state machine.
 *
 * The trader's spec: the self-aware tool should continuously watch every open trade, know the
 * original idea behind it, track how it develops through a real lifecycle, and alert when something
 * important changes -- always quoting the original reasoning. This file is the durable record and
 * the pure transition logic (no filesystem, no EA, no clock beyond what's passed in), so the whole
 * state machine is testable in isolation; trade-monitor-sweep.ts is the runtime that feeds it live
 * positions and sends the alerts.
 *
 * Design notes carried over from background-watch.ts (this codebase's hard-won rules):
 *  - Edge-triggered. Every alert fires ONCE per crossing, never once per sweep -- repeat alerts are
 *    the "the bot is disturbing me" bug. Each alert kind has a boolean latch on the record.
 *  - File-backed under DAVE_DATA_ROOT so a restart doesn't re-alert a trade that's sat in loss for
 *    an hour. A single duplicate after a restart is acceptable; a duplicate every sweep is not.
 *  - A closed ticket's record is finalized (state -> closed) and pruned when old, so the store
 *    never grows without bound.
 */

export type LifecycleState = "entry" | "losing" | "deep_loss" | "recovery" | "profit" | "closed";

export interface StateTransition {
  state: LifecycleState;
  at: number;
  /** Live price and P/L at the moment of transition -- the "relevant market information" the spec
   *  asks be recorded at every state change, so the trade's whole story is reconstructable. */
  price?: number;
  pnl?: number;
}

export interface TradeMonitor {
  ticket: string;
  symbol: string;
  direction: "buy" | "sell";
  openPrice: number;
  sl?: number;
  tp?: number;
  /** The original trade idea, captured once at first sight and quoted in every alert. */
  reason: string;
  openedAt: number;
  state: LifecycleState;
  history: StateTransition[];
  /** When the trade most recently entered a losing state (reset when it climbs back to profit) --
   *  drives the loss-duration alerts. */
  lossStartedAt?: number;
  /** When the trade most recently entered the flat "near breakeven" band (reset when it leaves) --
   *  drives the stuck-trade alert. */
  flatStartedAt?: number;
  /** Worst (most negative) P/L ever seen -- for the DEEP_LOSS classification and the story. */
  worstPnl?: number;
  /** True once the trade has been in loss long enough to make a later return to profit a genuine
   *  "recovery" worth announcing. */
  prolongedLoss?: boolean;
  lastPnl?: number;
  updatedAt: number;
  /** Edge-trigger latches -- each alert kind fires exactly once. */
  alerts: {
    loss5m?: boolean;
    loss10m?: boolean;
    slDanger?: boolean;
    recovery?: boolean;
    deepLoss?: boolean;
    breakeven?: boolean;
    stuck?: boolean;
  };
}

/** Loss-duration alert thresholds (the trader's numbers: ~5 min, then the 10-20 min window). */
export const LOSS_ALERT_5M_MS = 5 * 60_000;
export const LOSS_ALERT_10M_MS = 10 * 60_000;
/** A trade in loss at least this long makes a later return to profit a real recovery to announce. */
export const PROLONGED_LOSS_MS = LOSS_ALERT_5M_MS;
/** Fraction of the entry-to-SL distance travelled that counts as "deep" / genuine SL danger. */
export const DEEP_LOSS_SL_PROGRESS = 0.5;
/** Favorable move (in multiples of the entry-to-SL risk) at which the stop should go to breakeven.
 *  1.0 = the trade is up as much as it originally risked -- the classic "lock it in risk-free" point. */
export const BREAKEVEN_R = 1.0;
/** How close to entry (as a fraction of the entry-to-SL risk) still counts as "flat / near breakeven". */
export const FLAT_BAND_FRACTION = 0.15;
/** A trade sitting flat near breakeven this long is tying up capital doing nothing. */
export const STUCK_FLAT_MS = 15 * 60_000;
/** Keep at most this many finished (closed) monitors, newest first -- bounds the store. */
export const MAX_RETAINED_CLOSED_MONITORS = 100;
/** Consecutive wins that trip the hot-hand warning (the trader: "3+ wins in a row"). Lives here in
 *  the pure module so both the sweep and the per-turn context can share it without importing the
 *  EA-backed runtime. */
export const HOT_HAND_MIN_STREAK = 3;

function monitorsPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "trade-monitors.json");
}

export function readMonitors(userId: string): TradeMonitor[] {
  const path = monitorsPath(userId);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? (parsed as TradeMonitor[]) : [];
  } catch {
    // A corrupt store must never take down the sweep (shared process with the trading loop).
    return [];
  }
}

export function writeMonitors(userId: string, monitors: TradeMonitor[]): void {
  const path = monitorsPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Prune closed monitors beyond the cap, oldest first, keeping every still-open one.
  const open = monitors.filter((m) => m.state !== "closed");
  const closed = monitors.filter((m) => m.state === "closed").sort((a, b) => a.updatedAt - b.updatedAt);
  const keptClosed = closed.slice(Math.max(0, closed.length - MAX_RETAINED_CLOSED_MONITORS));
  writeFileSync(path, JSON.stringify([...open, ...keptClosed], null, 2), "utf8");
}

export function getMonitor(userId: string, ticket: string): TradeMonitor | undefined {
  return readMonitors(userId).find((m) => m.ticket === ticket);
}

export function listOpenMonitors(userId: string): TradeMonitor[] {
  return readMonitors(userId).filter((m) => m.state !== "closed");
}

/**
 * Directional distance from entry toward the stop, [0,1]. Only positive when price has moved in the
 * LOSING direction, so it never reads high on a winning trade (the exact bug fixed in
 * self-aware-sweep). undefined when there's no SL or the SL sits at entry.
 */
export function slProgress(m: Pick<TradeMonitor, "openPrice" | "sl">, currentPrice: number): number | undefined {
  if (m.sl === undefined) return undefined;
  const denom = m.openPrice - m.sl;
  if (denom === 0) return undefined;
  return Math.min(1, Math.max(0, (m.openPrice - currentPrice) / denom));
}

/** A market observation for one open position on one sweep. */
export interface PositionObservation {
  ticket: string;
  symbol: string;
  direction: "buy" | "sell";
  openPrice: number;
  sl?: number;
  tp?: number;
  currentPrice?: number;
  pnl?: number;
  reason: string;
}

/** The alerts a single advance() produced -- the sweep turns these into real messages. */
export type MonitorAlertKind = "loss5m" | "loss10m" | "slDanger" | "recovery" | "deepLoss" | "breakeven" | "stuck";
export interface MonitorAlert {
  kind: MonitorAlertKind;
  monitor: TradeMonitor;
}

function transition(m: TradeMonitor, state: LifecycleState, at: number, price?: number, pnl?: number): void {
  if (m.state === state) return;
  m.state = state;
  m.history.push({ state, at, price, pnl });
}

/**
 * Pure core: given the previous monitor (or undefined for a first sighting) and the current
 * observation, return the updated monitor plus any alerts that newly fired this tick. No I/O.
 *
 * `now` is injected so tests can drive time deterministically.
 */
export function advanceMonitor(
  prev: TradeMonitor | undefined,
  obs: PositionObservation,
  now: number,
  deepLossThreshold: number = DEEP_LOSS_SL_PROGRESS
): { monitor: TradeMonitor; alerts: MonitorAlert[] } {
  const m: TradeMonitor =
    prev ??
    {
      ticket: obs.ticket,
      symbol: obs.symbol,
      direction: obs.direction,
      openPrice: obs.openPrice,
      sl: obs.sl,
      tp: obs.tp,
      reason: obs.reason,
      openedAt: now,
      state: "entry",
      history: [{ state: "entry", at: now, price: obs.currentPrice, pnl: obs.pnl }],
      alerts: {},
      updatedAt: now,
    };
  // Keep live fields fresh (SL/TP can be modified after entry; reason only fills in if we learn it later).
  m.sl = obs.sl ?? m.sl;
  m.tp = obs.tp ?? m.tp;
  if (obs.reason && (!m.reason || m.reason === "(reason not recorded)")) m.reason = obs.reason;

  const pnl = obs.pnl;
  const price = obs.currentPrice;
  const alerts: MonitorAlert[] = [];
  if (pnl === undefined) {
    m.lastPnl = pnl;
    m.updatedAt = now;
    return { monitor: m, alerts };
  }

  m.worstPnl = m.worstPnl === undefined ? pnl : Math.min(m.worstPnl, pnl);
  const inLoss = pnl < 0;
  const progress = price !== undefined ? slProgress(m, price) : undefined;
  const deep = inLoss && progress !== undefined && progress >= deepLossThreshold;

  // Breakeven guard and stuck-trade -- independent of the loss/profit branch below (a trade can be
  // up ~1R or sitting flat regardless of the exact lifecycle state). Both need a live price and,
  // for a meaningful "in multiples of risk" measure, a stop.
  if (price !== undefined && m.sl !== undefined) {
    const risk = Math.abs(m.openPrice - m.sl);
    if (risk > 0) {
      const favorable = m.direction === "buy" ? price - m.openPrice : m.openPrice - price;
      // Breakeven: up as much as it risked -> suggest moving the stop to breakeven. Latched for the
      // life of the trade (a later dip must not re-suggest it).
      if (!m.alerts.breakeven && favorable >= risk * BREAKEVEN_R) {
        m.alerts.breakeven = true;
        alerts.push({ kind: "breakeven", monitor: m });
      }
      // Stuck: within a narrow band around entry for a sustained stretch. The clock starts when it
      // enters the band and resets the moment it leaves, so only genuine dead time fires.
      const flat = Math.abs(price - m.openPrice) <= risk * FLAT_BAND_FRACTION;
      if (flat) {
        if (m.flatStartedAt === undefined) m.flatStartedAt = now;
        if (now - m.flatStartedAt >= STUCK_FLAT_MS && !m.alerts.stuck) {
          m.alerts.stuck = true;
          alerts.push({ kind: "stuck", monitor: m });
        }
      } else {
        m.flatStartedAt = undefined;
        m.alerts.stuck = false;
      }
    }
  }

  if (inLoss) {
    if (m.lossStartedAt === undefined) m.lossStartedAt = now;
    const lossFor = now - m.lossStartedAt;
    if (lossFor >= PROLONGED_LOSS_MS) m.prolongedLoss = true;

    transition(m, deep ? "deep_loss" : "losing", now, price, pnl);

    if (deep && !m.alerts.deepLoss) {
      m.alerts.deepLoss = true;
      m.alerts.slDanger = true; // deep loss implies SL danger; don't double-fire the SL alert
      alerts.push({ kind: "deepLoss", monitor: m });
    } else if (!deep && progress !== undefined && progress >= deepLossThreshold && !m.alerts.slDanger) {
      m.alerts.slDanger = true;
      alerts.push({ kind: "slDanger", monitor: m });
    }
    if (lossFor >= LOSS_ALERT_5M_MS && !m.alerts.loss5m) {
      m.alerts.loss5m = true;
      alerts.push({ kind: "loss5m", monitor: m });
    }
    if (lossFor >= LOSS_ALERT_10M_MS && !m.alerts.loss10m) {
      m.alerts.loss10m = true;
      alerts.push({ kind: "loss10m", monitor: m });
    }
  } else {
    // Not in loss (>= 0). If it climbed here after a prolonged loss, that's a recovery to announce.
    const wasStruggling = m.state === "losing" || m.state === "deep_loss";
    if (m.prolongedLoss && wasStruggling && !m.alerts.recovery) {
      m.alerts.recovery = true;
      transition(m, "recovery", now, price, pnl);
      alerts.push({ kind: "recovery", monitor: m });
    }
    transition(m, "profit", now, price, pnl);
    // Reset the loss clock and its one-shot latches so a fresh dip later re-arms cleanly.
    m.lossStartedAt = undefined;
    m.prolongedLoss = false;
    m.alerts.loss5m = false;
    m.alerts.loss10m = false;
    m.alerts.slDanger = false;
    m.alerts.deepLoss = false;
  }

  m.lastPnl = pnl;
  m.updatedAt = now;
  return { monitor: m, alerts };
}

/** Marks a monitor closed (its ticket vanished from the live snapshot) and records the transition. */
export function closeMonitor(m: TradeMonitor, now: number): TradeMonitor {
  if (m.state !== "closed") {
    m.state = "closed";
    m.history.push({ state: "closed", at: now, pnl: m.lastPnl });
    m.updatedAt = now;
  }
  return m;
}
