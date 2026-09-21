import { getLastKnownState } from "@dave/ea-bridge";
import { getTradeLifecycle } from "@dave/feedback";
import { recordOutcome, getDeepLossAlertProgress, getAlertToggles, getWinStreak, type AlertCategory, type TradeExecutor } from "@dave/trading";
import type { DaveDatabase } from "@dave/db";
import {
  readMonitors,
  writeMonitors,
  advanceMonitor,
  closeMonitor,
  HOT_HAND_MIN_STREAK,
  REASON_NOT_RECORDED,
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

/** How far back the quick check's momentum read looks. Long enough to be a trend rather than one
 *  sweep's jitter, short enough to describe where the trade is going NOW. */
const MOMENTUM_WINDOW_MS = 3 * 60_000;

export interface TradeMonitorSweepDeps {
  db: DaveDatabase;
  userId: string;
  notify: (text: string) => Promise<void>;
  /**
   * Real bug fixed (the trader: "breakeven doesn't work"). These deps carried ONLY `notify`, so the
   * breakeven alert could say "enough to move the stop to breakeven" and then, by construction, do
   * nothing at all -- there was no path from this sweep to the position. With a real executor the
   * alert becomes an action. Optional so existing callers/tests that only assert on messages keep
   * working; when it is absent the alert honestly reverts to advice.
   */
  executor?: TradeExecutor;
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
  return REASON_NOT_RECORDED;
}

/** The cached reason when it is genuinely known, otherwise a fresh journal lookup. */
function realReasonOrRetry(deps: TradeMonitorSweepDeps, cached: string | undefined, ticket: string): string {
  if (cached && cached !== REASON_NOT_RECORDED) return cached;
  return reasonFor(deps.db, deps.userId, ticket);
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
    case "profitStable":
      return "profit_stable";
    case "profitDrop":
      return "profit_drop";
    case "peakPullback":
      return "peak_pullback";
    case "range":
      return "range";
    case "quickProfitCheck":
      return "quick_profit_check";
  }
}

/** Money as the trader reads it in these alerts. */
function money(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}`;
}

/**
 * The trade's original target expressed the way the spec's example shows it (`Target: +2.0%`),
 * derived from the stored TP against the entry. A trade with no TP says so rather than having a
 * number invented for it.
 */
function targetLine(m: TradeMonitor): string {
  if (m.tp === undefined || m.openPrice === 0) return "Target: none set";
  const movePct = (Math.abs(m.tp - m.openPrice) / m.openPrice) * 100;
  return `Target: ${movePct.toFixed(1)}% (${m.tp})`;
}

/**
 * Momentum read off the rolling sample history rather than a fresh EA analysis call. The spec calls
 * the quick check "lightweight", and this runs every 30s for every open position -- pulling a full
 * analysis suite per trade per check would not be lightweight. Compares the newest reading against
 * the oldest still inside the momentum window.
 */
function momentumLine(m: TradeMonitor, now: number): string {
  const window = (m.samples ?? []).filter((s) => now - s.at <= MOMENTUM_WINDOW_MS);
  if (window.length < 2) return "Momentum: not enough history yet";
  const first = window[0].pnl;
  const last = window[window.length - 1].pnl;
  const delta = last - first;
  const dir = delta > 0 ? "building" : delta < 0 ? "fading" : "flat";
  return `Momentum: ${dir} (${money(delta)} over the last ${fmtDuration(now - window[0].at)})`;
}

/** What actually happened when a breakeven alert tried to move the stop. "advice" means no
 *  executor was wired, so nothing was attempted and the message must not claim otherwise. */
export type BreakevenOutcome =
  | { status: "moved"; level: number }
  | { status: "failed"; level: number; error: string }
  | { status: "advice" };

export function buildMonitorAlert(a: MonitorAlert, now: number, breakeven?: BreakevenOutcome): string {
  const m = a.monitor;
  const head = `${m.symbol} ${m.direction.toUpperCase()} (ticket #${m.ticket})`;
  const pnl = m.lastPnl !== undefined ? ` P/L ${m.lastPnl > 0 ? "+" : ""}${m.lastPnl}` : "";
  const lossFor = m.lossStartedAt ? fmtDuration(now - m.lossStartedAt) : "";
  const flatFor = m.flatStartedAt ? fmtDuration(now - m.flatStartedAt) : "";
  const why = `\n\n📌 Original idea: ${m.reason}`;
  const inProfitFor = m.profitStartedAt ? fmtDuration(now - m.profitStartedAt) : "a while";
  const dropAmount = m.bestPnl !== undefined && m.lastPnl !== undefined ? money(m.lastPnl - m.bestPnl) : "unknown";
  const peakWhen = m.bestPnlAt ? ` (${fmtDuration(now - m.bestPnlAt)} ago)` : "";
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
    case "breakeven": {
      // Real bug fixed (the trader: "breakeven doesn't work"). This used to be pure advice -- it
      // told the trader the stop *should* move and nothing ever moved it. It now reports what
      // genuinely happened, and a failed move says so plainly rather than quietly implying the
      // trade is protected when it isn't.
      if (breakeven?.status === "moved") {
        return `🎯 ${head} is up about 1R — I've moved the stop to breakeven (${breakeven.level}). This trade is now risk-free.${pnl}${why}`;
      }
      if (breakeven?.status === "failed") {
        return `🎯 ${head} is up about 1R, but I could NOT move the stop to breakeven (${breakeven.level}) — ${breakeven.error}. The trade is still carrying full risk; move it by hand if you want it locked in.${pnl}${why}`;
      }
      return `🎯 ${head} is up about 1R — enough to move the stop to breakeven and make it a risk-free trade.${pnl}${why}`;
    }
    case "stuck":
      return `😴 ${head} has sat flat near breakeven for ${flatFor}.${pnl} It's tying up capital doing nothing — consider closing and freeing the margin.${why}`;

    /* ---- the trader's five profit-side checks ---- */

    // 1. "Is the original trade plan still valid? Are current market conditions still supporting
    //    the trade? Is the trade still progressing according to the original idea?"
    case "profitStable":
      return (
        `🟢 PROFIT STABILITY CHECK\n\n${head} has held profit for ${inProfitFor}.${pnl}${why}\n\n` +
        `Self-check: is the original plan still valid, do conditions still support it, and is it still progressing toward the original idea?`
      );

    // 2. "Current profit / previous higher profit / amount of reduction / original idea / plan status"
    case "profitDrop":
      return (
        `🔻 PROFIT DROPPING\n\n${head} was profitable for ${inProfitFor} and is now giving it back.\n` +
        `Current profit: ${m.lastPnl !== undefined ? money(m.lastPnl) : "unknown"}\n` +
        `Previous peak: ${m.bestPnl !== undefined ? money(m.bestPnl) : "unknown"}\n` +
        `Reduction: ${dropAmount}${why}\n\n` +
        `Self-check: has the plan changed, or is this normal noise on the way to the target?`
      );

    // 3. "Peak profit / current profit / pullback amount / original idea / whether the plan still
    //    appears valid"
    case "peakPullback":
      return (
        `📉 PEAK PULLBACK\n\n${head} has pulled back from its best level.\n` +
        `Peak profit: ${m.bestPnl !== undefined ? money(m.bestPnl) : "unknown"}${peakWhen}\n` +
        `Current profit: ${m.lastPnl !== undefined ? money(m.lastPnl) : "unknown"}\n` +
        `Pullback: ${dropAmount}${why}\n\n` +
        `Self-check: does the original plan still appear valid, or has this already made its move?`
      );

    // 4. The spec's own example format, including the direction and duration lines.
    case "range":
      return (
        `🟡 RANGE DETECTED\n\nPrice has repeatedly moved up and down within the same range.\n\n` +
        `Current trade: ${m.direction.toUpperCase()} ${m.symbol} (ticket #${m.ticket})\n` +
        `Trade duration: ${fmtDuration(now - m.openedAt)}${pnl}${why}\n\n` +
        `Self-check: is the original thesis still valid? The expected directional move has not developed.`
      );

    // 5. "Current profit / trade duration / original target / current momentum / original thesis"
    case "quickProfitCheck":
      return (
        `🔵 QUICK PROFIT CHECK\n\nTrade has been profitable for ${inProfitFor}.\n\n` +
        `${targetLine(m)}\n` +
        `Current profit: ${m.lastPnl !== undefined ? money(m.lastPnl) : "unknown"}\n` +
        `Trade duration: ${fmtDuration(now - m.openedAt)}\n` +
        `${momentumLine(m, now)}${why}\n\n` +
        `Self-check: is this trade still trying to reach the original objective?`
      );
  }
}

/**
 * Moves a position's stop to its entry price -- the real action behind the breakeven alert. Never
 * throws: a broker rejection, a disconnected EA or a missing executor all resolve to an outcome the
 * message can state honestly. Same executor contract the trailing-stop runtime already uses.
 */
async function moveStopToBreakeven(deps: TradeMonitorSweepDeps, m: TradeMonitor): Promise<BreakevenOutcome> {
  if (!deps.executor) return { status: "advice" };
  try {
    await deps.executor.modifyOrder(m.ticket, { sl: m.openPrice });
    console.log(`[trade-monitor] ${deps.userId}: moved #${m.ticket} (${m.symbol}) stop to breakeven ${m.openPrice}`);
    return { status: "moved", level: m.openPrice };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[trade-monitor] ${deps.userId}: breakeven move failed for #${m.ticket}:`, err);
    return { status: "failed", level: m.openPrice, error };
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
      // Real bug fixed (the trader: "reason not added"). `??` only falls through on null/undefined,
      // and the placeholder is a truthy string -- so the FIRST sweep that ran before the journal row
      // existed (logTrade lands a moment after the position appears in the EA snapshot) cached
      // "(reason not recorded)" and this line then served that cached miss forever, never asking the
      // journal again. A placeholder is a cache MISS, not a value: re-query until a real reason
      // exists, then it sticks.
      reason: realReasonOrRetry(deps, byTicket.get(p.ticket)?.reason, p.ticket),
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
    // Breakeven is the one alert that DOES something: move the real stop to the entry price before
    // telling the trader about it, so the message reports a fact rather than a suggestion. The
    // alert's latch was already set in advanceMonitor, so a failed move is reported once and never
    // retried every 30s -- a broker that refuses this stop will keep refusing it.
    const breakeven = a.kind === "breakeven" ? await moveStopToBreakeven(deps, a.monitor) : undefined;
    try {
      await deps.notify(buildMonitorAlert(a, now, breakeven));
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
