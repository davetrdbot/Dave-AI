import { getLastKnownState } from "@dave/ea-bridge";
import { getTradeLifecycle } from "@dave/feedback";
import { recordOutcome, getDeepLossAlertProgress, getAlertToggles, getWinStreak, type AlertCategory } from "@dave/trading";
import type { DaveDatabase } from "@dave/db";
import {
  readMonitors,
  writeMonitors,
  advanceMonitor,
  closeMonitor,
  HOT_HAND_MIN_STREAK,
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

/** Which on/off switch governs each raw alert kind. */
export function alertCategoryOf(kind: MonitorAlertKind): AlertCategory {
  switch (kind) {
    case "loss5m":
    case "loss10m":
      return "loss_duration";
    case "deepLoss":
    case "slDanger":
      return "deep_loss";
    case "recovery":
      return "recovery";
    case "breakeven":
      return "breakeven";
    case "stuck":
      return "stuck";
  }
}

export function buildMonitorAlert(a: MonitorAlert, now: number): string {
  const m = a.monitor;
  const head = `${m.symbol} ${m.direction.toUpperCase()} (ticket #${m.ticket})`;
  const pnl = m.lastPnl !== undefined ? ` P/L ${m.lastPnl > 0 ? "+" : ""}${m.lastPnl}` : "";
  const lossFor = m.lossStartedAt ? fmtDuration(now - m.lossStartedAt) : "";
  const flatFor = m.flatStartedAt ? fmtDuration(now - m.flatStartedAt) : "";
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
    case "breakeven":
      return `🎯 ${head} is up about 1R — enough to move the stop to breakeven and make it a risk-free trade.${pnl}${why}`;
    case "stuck":
      return `😴 ${head} has sat flat near breakeven for ${flatFor}.${pnl} It's tying up capital doing nothing — consider closing and freeing the margin.${why}`;
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
  // Every self-aware alert has an on/off switch (default on). Read once per sweep. A disabled
  // category is silenced for BOTH the user push and Dave's own context surfacing.
  const toggles = getAlertToggles(deps.userId);

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
  const hotHandMessages: string[] = [];
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
        // Hot-hand: a winning close that makes it exactly 3 in a row. Fired once at the crossing
        // (a 4th/5th win won't re-nag); a loss resets the streak so it can arm again later.
        const isWin = closed.lastPnl !== undefined && closed.lastPnl > 0;
        if (isWin && toggles.hot_hand && getWinStreak(deps.userId) === HOT_HAND_MIN_STREAK) {
          hotHandMessages.push(
            `🔥 Hot hand: that's ${HOT_HAND_MIN_STREAK} wins in a row. This is exactly when traders oversize and loosen their rules — ` +
              `keep your risk per trade and your entry criteria identical. The streak doesn't change the math.`
          );
        }
      } catch (err) {
        console.error(`[trade-monitor] ${deps.userId}: could not record outcome for #${closed.ticket}:`, err);
      }
    }
  }

  writeMonitors(deps.userId, next);

  // Push per-trade alerts, silencing any whose category the user switched off.
  for (const a of fired) {
    if (!toggles[alertCategoryOf(a.kind)]) continue;
    try {
      await deps.notify(buildMonitorAlert(a, now));
    } catch (err) {
      console.error(`[trade-monitor] ${deps.userId}: alert ${a.kind} for #${a.monitor.ticket} failed to send:`, err);
    }
  }
  for (const msg of hotHandMessages) {
    try {
      await deps.notify(msg);
    } catch (err) {
      console.error(`[trade-monitor] ${deps.userId}: hot-hand alert failed to send:`, err);
    }
  }
  // Only return the categories that were actually delivered, so callers/tests see real behaviour.
  return fired.filter((a) => toggles[alertCategoryOf(a.kind)]);
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
