import { getLastKnownState } from "@dave/ea-bridge";
import { getTradeLifecycle } from "@dave/feedback";
import { recordOutcome, getDeepLossAlertProgress } from "@dave/trading";
import type { DaveDatabase } from "@dave/db";
import {
  readMonitors,
  writeMonitors,
  advanceMonitor,
  closeMonitor,
  type TradeMonitor,
  type MonitorAlert,
  type MonitorAlertKind,
  type PositionObservation,
} from "./trade-monitor-store.js";

/**
 * The runtime half of the Self-Aware Trade Monitor. On its own timer it reads every live open
 * position off the EA snapshot, drives each one's lifecycle state machine (trade-monitor-store.ts),
 * and pushes an alert -- always quoting the trade's original idea -- whenever something important
 * changes. Runs regardless of whether autonomous trading is on. Supersedes the earlier, thinner
 * self-aware-sweep (which only did the single 50%-SL alert).
 */

const SWEEP_INTERVAL_MS = 30_000;

export interface TradeMonitorSweepDeps {
  db: DaveDatabase;
  userId: string;
  notify: (text: string) => Promise<void>;
}

function reasonFor(db: DaveDatabase, userId: string, ticket: string): string {
  try {
    const lifecycle = getTradeLifecycle(db, userId, { ticket });
    const entry = lifecycle[lifecycle.length - 1];
    const r = entry?.reasoning?.join(" ")?.trim();
    if (r) return r;
  } catch {
    /* no journal entry for this ticket */
  }
  return "(reason not recorded)";
}

function fmtDuration(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 1 ? "under a minute" : `${m} min`;
}

export function buildMonitorAlert(a: MonitorAlert, now: number): string {
  const m = a.monitor;
  const head = `${m.symbol} ${m.direction.toUpperCase()} (ticket #${m.ticket})`;
  const pnl = m.lastPnl !== undefined ? ` P/L ${m.lastPnl > 0 ? "+" : ""}${m.lastPnl}` : "";
  const lossFor = m.lossStartedAt ? fmtDuration(now - m.lossStartedAt) : "";
  const why = `\n\n📌 Original idea: ${m.reason}`;
  switch (a.kind) {
    case "loss5m":
      return `⏳ ${head} has been in the red about ${lossFor}.${pnl} Still losing — worth a look at whether the idea holds.${why}`;
    case "loss10m":
      return `⏳ ${head} has now been losing for ${lossFor}.${pnl} This is dragging — decide: hold, cut, or adjust.${why}`;
    case "deepLoss":
      return `🚨 ${head} is in DEEP loss — past your alert level on the way to its stop.${pnl} Genuinely close to being stopped out.${why}`;
    case "slDanger":
      return `⚠️ ${head} has reached your deep-loss alert level toward its stop.${pnl}${why}`;
    case "recovery":
      return `🟢 ${head} has climbed back to profit after being under water for a stretch.${pnl} The idea recovered.${why}`;
  }
}

/** One real pass. Returns the alerts that newly fired this pass, for testability. */
export async function runTradeMonitorSweep(deps: TradeMonitorSweepDeps, now: number = Date.now()): Promise<MonitorAlert[]> {
  const { positions } = getLastKnownState(deps.userId);
  const monitors = readMonitors(deps.userId);
  const byTicket = new Map(monitors.map((m) => [m.ticket, m]));
  const openTickets = new Set(positions.map((p) => p.ticket));

  const fired: MonitorAlert[] = [];
  const next: TradeMonitor[] = [];
  // The trader's own deep-loss alert level (default 50% -- halfway to the stop), read fresh each
  // sweep so a change takes effect on the very next pass with no restart.
  const deepLossThreshold = getDeepLossAlertProgress(deps.userId);

  // Advance each currently-open position.
  for (const p of positions) {
    const obs: PositionObservation = {
      ticket: p.ticket,
      symbol: p.symbol,
      direction: p.type,
      openPrice: p.openPrice,
      sl: p.sl,
      tp: p.tp,
      currentPrice: p.currentPrice,
      pnl: p.pnl,
      reason: byTicket.get(p.ticket)?.reason ?? reasonFor(deps.db, deps.userId, p.ticket),
    };
    const { monitor, alerts } = advanceMonitor(byTicket.get(p.ticket), obs, now, deepLossThreshold);
    next.push(monitor);
    byTicket.delete(p.ticket);
    fired.push(...alerts);
  }

  // Everything left in byTicket is a monitor whose ticket is no longer open -> close it (once),
  // and fold what actually happened into the prediction/similarity database (spec parts 4 & 5).
  for (const m of byTicket.values()) {
    const wasOpen = m.state !== "closed";
    const closed = closeMonitor(m, now);
    next.push(closed);
    if (wasOpen) {
      try {
        recordOutcome(deps.userId, {
          ticket: closed.ticket,
          symbol: closed.symbol,
          direction: closed.direction,
          actual: {
            durationMinutes: Math.round((now - closed.openedAt) / 60_000),
            closePnl: closed.lastPnl,
            worstPnl: closed.worstPnl,
          },
        });
      } catch (err) {
        console.error(`[trade-monitor] ${deps.userId}: could not record outcome for #${closed.ticket}:`, err);
      }
    }
  }

  writeMonitors(deps.userId, next);

  for (const a of fired) {
    try {
      await deps.notify(buildMonitorAlert(a, now));
    } catch (err) {
      console.error(`[trade-monitor] ${deps.userId}: alert ${a.kind} for #${a.monitor.ticket} failed to send:`, err);
    }
  }
  return fired;
}

const active = new Map<string, ReturnType<typeof setInterval>>();

export function startTradeMonitorSweep(deps: TradeMonitorSweepDeps, intervalMs = SWEEP_INTERVAL_MS): boolean {
  if (active.has(deps.userId)) return false;
  const handle = setInterval(() => {
    void runTradeMonitorSweep(deps).catch((err) => console.error(`[trade-monitor] ${deps.userId}: sweep failed:`, err));
  }, intervalMs);
  active.set(deps.userId, handle);
  return true;
}

export function stopTradeMonitorSweep(userId: string): boolean {
  const handle = active.get(userId);
  if (!handle) return false;
  clearInterval(handle);
  active.delete(userId);
  return true;
}
