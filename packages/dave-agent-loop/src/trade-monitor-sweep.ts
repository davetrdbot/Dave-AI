import { getLastKnownState, getLastKnownAccountSnapshot } from "@dave/ea-bridge";
import { getTradeLifecycle } from "@dave/feedback";
import { breakevenStop, recordOutcome, getDeepLossAlertProgress, getSlAlertLevels, getAlertToggles, getWinStreak, type AlertCategory, type TradeExecutor } from "@dave/trading";
import type { DaveDatabase } from "@dave/db";
import {
  readMonitors,
  writeMonitors,
  advanceMonitor,
  closeMonitor,
  HOT_HAND_MIN_STREAK,
  REASON_NOT_RECORDED,
  SL_NEAR_PROGRESS,
  SL_CRITICAL_PROGRESS,
  TP_NEAR_PROGRESS,
  type TradeMonitor,
  type MonitorAlert,
  type MonitorAlertKind,
  type PositionObservation,
  rMultiple,
  riskOf,
  slProgress,
} from "./trade-monitor-store.js";
import { outcomeLine, recordTradeClosed } from "./alert-outcomes.js";
import { reviewTrade, REVIEW_KINDS, type ReviewDeps } from "./self-aware-review.js";
import { exitRuleFor, describeExitRule, runExitRules, type ExitRule } from "./exit-rules.js";
import { safetyChecks, resetSafetyState } from "./safety-alerts.js";

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
  /** `symbol`: set on a per-trade alert -- mode 2 looks at that trade on the next scan. */
  notify: (text: string, about?: { symbol: string }) => Promise<void>;
  /**
   * Real bug fixed (the trader: "breakeven doesn't work"). These deps carried ONLY `notify`, so the
   * breakeven alert could say "enough to move the stop to breakeven" and then, by construction, do
   * nothing at all -- there was no path from this sweep to the position. With a real executor the
   * alert becomes an action. Optional so existing callers/tests that only assert on messages keep
   * working; when it is absent the alert honestly reverts to advice.
   */
  executor?: TradeExecutor;
  /** Self-aware v2: Dave reviews a trade when an alert calls for a decision (self-aware-review.ts).
   *  Absent = alerts only. */
  review?: Pick<ReviewDeps, "provider" | "analysis">;
  /** Tests: wait for the reviews instead of letting them run in the background. */
  awaitReviews?: boolean;
}

/** MT5 reports every few seconds; this long without a report means the monitor is blind. */
export const FEED_STALE_MS = 3 * 60_000;
/** Account heat: total floating loss at or past this share of the balance... */
export const PORTFOLIO_HEAT_PCT = 3;
/** ...or at least this many trades open and every one of them losing. */
export const PORTFOLIO_LOSERS_MIN = 3;
export const PORTFOLIO_COOLDOWN_MS = 30 * 60_000;

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
    case "slLevel":
      return "deep_loss";
    case "slNear":
      return "sl_near";
    case "slCritical":
      return "sl_critical";
    case "tpNear":
      return "tp_near";
    case "roundTrip":
      return "round_trip";
    case "neverGreen":
      return "never_green";
    case "racing":
      return "momentum";
    case "noStop":
      return "no_stop";
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

export function buildMonitorAlert(a: MonitorAlert, now: number, breakeven?: BreakevenOutcome, exitRule?: ExitRule): string {
  return withExitHint(a, buildAlertBody(a, now, breakeven), exitRule);
}

/** The kinds where a trade is going nowhere in loss -- the moment an automatic scratch exit helps. */
const CHOP_KINDS = new Set<MonitorAlertKind>(["loss5m", "loss10m", "range", "stuck", "deepLoss", "slDanger", "slNear", "slLevel", "roundTrip", "neverGreen", "racing", "noStop"]);

/** Every loss-side alert says what exit is armed on the trade -- or how to arm one. */
function withExitHint(a: MonitorAlert, body: string, rule?: ExitRule): string {
  if (rule) return `${body}\n\n🛟 Exit rule armed: ${describeExitRule(rule)}.`;
  if (!CHOP_KINDS.has(a.kind)) return body;
  const m = a.monitor;
  const swing = m.bestPnl !== undefined && m.worstPnl !== undefined ? ` Its range so far: best ${money(m.bestPnl)}, worst ${money(m.worstPnl)}.` : "";
  return `${body}\n\n🛟 No exit rule on it.${swing} Option: set_exit_rule to close it automatically if it recovers (breakeven or a small profit) and/or cut it at a fixed loss -- instead of watching it chop.`;
}

function buildAlertBody(a: MonitorAlert, now: number, breakeven?: BreakevenOutcome): string {
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

    // Escalating proximity warnings. Each states the real percentage and the real level, so the
    // trader can act without opening the terminal to work out where price actually is.
    case "slNear":
      return (
        `⚠️ NEARLY STOPPED OUT\n\n${head} has travelled ${Math.round((a.level ?? SL_NEAR_PROGRESS) * 100)}% of the way from entry to its stop (${m.sl}).${pnl}${why}\n\n` +
        `Self-check: is the idea genuinely broken, or is this the noise you expected? Decide now — cut, adjust the stop, or hold deliberately.`
      );
    case "slCritical":
      return (
        `🚨 ABOUT TO BE STOPPED OUT\n\n${head} is ${Math.round((a.level ?? SL_CRITICAL_PROGRESS) * 100)}% of the way to its stop (${m.sl}).${pnl}${why}\n\n` +
        `This is the last moment to act deliberately rather than letting the stop decide for you.`
      );
    case "slLevel":
      return (
        `📉 ${Math.round((a.level ?? 0) * 100)}% OF THE WAY TO THE STOP\n\n${head} has travelled ${Math.round((a.level ?? 0) * 100)}% from entry toward its stop (${m.sl}).${pnl}${why}\n\n` +
        `Self-check: is the level your idea depended on still holding? Hold deliberately, tighten, or cut -- don't just watch it go.`
      );
    case "tpNear":
      return (
        `🎯 NEARLY AT TARGET\n\n${head} has covered ${Math.round(TP_NEAR_PROGRESS * 100)}% of the distance from entry to its take profit (${m.tp}).${pnl}${why}\n\n` +
        `Self-check: let it run to target, take partial profit here, or tighten the stop to protect what it has already made?`
      );

    /* ---- self-aware v2 ---- */
    case "roundTrip":
      return (
        `↩️ WINNER TURNED LOSER\n\n${head} was up ${m.mfeR !== undefined ? `${m.mfeR}R` : m.bestPnl !== undefined ? money(m.bestPnl) : "well"}${m.bestPnl !== undefined ? ` (best ${money(m.bestPnl)})` : ""} and is back in the red.${pnl}${why}\n\n` +
        `Self-check: the move you wanted happened and reversed. Is there still a reason to be in, or is this now a different trade? (A breakeven or partial at +0.5-1R would have kept this one.)`
      );
    case "neverGreen":
      return (
        `🕳️ NEVER WENT GREEN\n\n${head} has been open ${fmtDuration(now - m.openedAt)} without one moment in profit${m.maeR !== undefined ? ` (worst ${m.maeR}R)` : ""}.${pnl}${why}\n\n` +
        `Self-check: a right entry usually pays something early. Did you enter ahead of the trigger, or is the idea wrong?`
      );
    case "racing":
      return (
        `🏃 RACING TO THE STOP\n\n${head} just moved ${m.raceR !== undefined ? `${m.raceR}R` : "fast"} against you in a few minutes${m.sl !== undefined ? ` toward the stop (${m.sl})` : ""}.${pnl}${why}\n\n` +
        `Self-check: momentum like this is information -- news, a liquidity sweep, or a real break of the level your idea stood on?`
      );
    case "noStop":
      return (
        `🚫 NO STOP LOSS\n\n${head} has no stop loss -- nothing caps the loss if price runs.${pnl}${why}\n\n` +
        `Put a stop where the idea is proven wrong (modify_sl_tp), or at least arm a cut-loss exit rule.`
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

/** Where the trade stands, in one line: R, money, time in, best/worst. */
export function statusLine(m: TradeMonitor, now: number, price?: number): string {
  const r = price !== undefined ? rMultiple(m, price) : undefined;
  const parts = [
    r !== undefined ? `${r > 0 ? "+" : ""}${r}R` : null,
    m.lastPnl !== undefined ? `P/L ${money(m.lastPnl)}` : null,
    `${fmtDuration(now - m.openedAt)} in`,
    m.mfeR !== undefined && m.maeR !== undefined ? `best ${m.mfeR}R / worst ${m.maeR}R` : m.bestPnl !== undefined && m.worstPnl !== undefined ? `best ${money(m.bestPnl)} / worst ${money(m.worstPnl)}` : null,
    price !== undefined && slProgress(m, price) !== undefined && (m.lastPnl ?? 0) < 0 ? `${Math.round((slProgress(m, price) as number) * 100)}% to the stop` : null,
  ].filter(Boolean);
  return `📊 ${m.symbol} ${m.direction.toUpperCase()} #${m.ticket}: ${parts.join(" · ")}`;
}

/**
 * Every alert one trade raised in one sweep, as ONE message: where it stands, each alert, the
 * original idea once (not once per alert), what history says, and the exit rule on it. Before,
 * a trade crossing three thresholds at once sent three messages each quoting the whole idea.
 */
export function buildTradeMessage(
  userId: string,
  alerts: MonitorAlert[],
  now: number,
  opts: { breakeven?: BreakevenOutcome; exitRule?: ExitRule; price?: number } = {}
): string {
  const m = alerts[0].monitor;
  const why = `\n\n📌 Original idea: ${m.reason}`;
  const bodies = alerts.map((a) => buildAlertBody(a, now, a.kind === "breakeven" ? opts.breakeven : undefined).split(why).join(""));
  const history = [...new Set(alerts.map((a) => outcomeLine(userId, a.kind, now)).filter((x): x is string => !!x))];
  const body = [statusLine(m, now, opts.price), ...bodies].join("\n\n") + why + (history.length ? `\n\n${history.join("\n")}` : "");
  // The exit hint once, keyed off the most serious loss-side alert in the batch.
  const chop = alerts.find((a) => CHOP_KINDS.has(a.kind));
  return withExitHint(chop ?? alerts[0], body, opts.exitRule);
}

/**
 * Moves a position's stop to its entry price -- the real action behind the breakeven alert. Never
 * throws: a broker rejection, a disconnected EA or a missing executor all resolve to an outcome the
 * message can state honestly. Same executor contract the trailing-stop runtime already uses.
 */
async function moveStopToBreakeven(deps: TradeMonitorSweepDeps, m: TradeMonitor): Promise<BreakevenOutcome> {
  if (!deps.executor) return { status: "advice" };
  // True breakeven: past the entry by the live spread, so a hit closes at 0.00, not -spread.
  const p = getLastKnownState(deps.userId).positions.find((x) => x.ticket === m.ticket);
  const be = breakevenStop({ side: m.direction, openPrice: m.openPrice, currentPrice: p?.currentPrice, spread: p?.spread, digits: p?.digits, stopsLevel: p?.stopsLevel });
  if (!be.ok) return { status: "failed", level: be.level, error: be.reason };
  if (p?.sl && (m.direction === "buy" ? p.sl >= be.level : p.sl <= be.level)) return { status: "moved", level: p.sl };
  try {
    await deps.executor.modifyOrder(m.ticket, { sl: be.level });
    console.log(`[trade-monitor] ${deps.userId}: moved #${m.ticket} (${m.symbol}) stop to breakeven ${be.level} (entry ${m.openPrice} + spread)`);
    return { status: "moved", level: be.level };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[trade-monitor] ${deps.userId}: breakeven move failed for #${m.ticket}:`, err);
    return { status: "failed", level: be.level, error };
  }
}

/** One real pass. Returns the alerts that newly fired this pass, for testability. */
export async function runTradeMonitorSweep(deps: TradeMonitorSweepDeps, now: number = Date.now()): Promise<MonitorAlert[]> {
  const { positions } = getLastKnownState(deps.userId);
  // A frozen feed: every price and P/L below would be stale, and the time-based alerts ("stuck
  // flat 15 min", "losing 10 min") would fire on a picture that stopped moving. Say so once and
  // hold the monitors still until MT5 reports again.
  const feed = feedCheck(deps.userId, positions.length, now);
  if (feed.message && getAlertToggles(deps.userId).feed) {
    await deps.notify(feed.message).catch((err) => console.error(`[trade-monitor] ${deps.userId}: feed alert failed:`, err));
  }
  if (feed.stale) return [];
  const monitors = readMonitors(deps.userId);
  // Back from a blind stretch: what the trades did in the gap is unknown, so the clocks and the
  // price history restart now -- or "stuck flat 20 min" would fire on time nobody watched.
  if (feed.recovered) {
    for (const m of monitors) {
      if (m.state === "closed") continue;
      m.flatStartedAt = undefined;
      m.lossStartedAt = undefined;
      m.profitStartedAt = undefined;
      m.samples = [];
    }
  }
  const byTicket = new Map(monitors.map((m) => [m.ticket, m]));
  const openTickets = new Set(positions.map((p) => p.ticket));

  const fired: MonitorAlert[] = [];
  const next: TradeMonitor[] = [];
  // The trader's own deep-loss alert level (default 50% -- halfway to the stop), read fresh each
  // sweep so a change takes effect on the very next pass with no restart.
  const deepLossThreshold = getDeepLossAlertProgress(deps.userId);
  // The trader's stop-loss warning ladder (Settings > Alerts), as fractions -- lowest = deep loss.
  const slLadder = getSlAlertLevels(deps.userId).map((l) => l / 100);
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
    const { monitor, alerts } = advanceMonitor(byTicket.get(p.ticket), obs, now, deepLossThreshold, slLadder);
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
        // The outcome memory: what happened after every alert and verdict on this trade.
        recordTradeClosed(deps.userId, closed, now);
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

  // Push per-trade alerts, silencing any whose category the user switched off -- one message per
  // trade per sweep, however many thresholds it crossed at once.
  const delivered = fired.filter((a) => toggles[alertCategoryOf(a.kind)]);
  const byTrade = new Map<string, MonitorAlert[]>();
  for (const a of delivered) byTrade.set(a.monitor.ticket, [...(byTrade.get(a.monitor.ticket) ?? []), a]);
  const reviews: Promise<unknown>[] = [];
  for (const [ticket, list] of byTrade) {
    // Breakeven is the one alert that DOES something: move the real stop to the entry price before
    // telling the trader about it, so the message reports a fact rather than a suggestion. The
    // alert's latch was already set in advanceMonitor, so a failed move is reported once and never
    // retried every 30s -- a broker that refuses this stop will keep refusing it.
    const be = list.find((a) => a.kind === "breakeven");
    const breakeven = be ? await moveStopToBreakeven(deps, be.monitor) : undefined;
    const price = positions.find((p) => p.ticket === ticket)?.currentPrice;
    const text = buildTradeMessage(deps.userId, list, now, { breakeven, exitRule: exitRuleFor(deps.userId, ticket), price });
    try {
      await deps.notify(text, { symbol: list[0].monitor.symbol });
    } catch (err) {
      console.error(`[trade-monitor] ${deps.userId}: alerts ${list.map((a) => a.kind).join(",")} for #${ticket} failed to send:`, err);
    }
    // An alert that calls for a decision gets one: Dave reviews the trade (self-aware-review.ts).
    const decide = list.filter((a) => REVIEW_KINDS.has(a.kind)).map((a) => a.kind);
    if (deps.review && decide.length && breakeven?.status !== "moved") {
      const job = reviewTrade({ ...deps.review, userId: deps.userId, executor: deps.executor, notify: deps.notify }, list[0].monitor, decide, text, now);
      reviews.push(job);
    }
  }
  if (deps.awaitReviews) await Promise.all(reviews);

  // Account heat: the trades together, not one at a time.
  const heat = portfolioHeat(deps.userId, positions, now);
  if (heat && toggles.portfolio) hotHandMessages.push(heat);
  // Spread spikes, low margin, stops inside the spread, the Friday close.
  hotHandMessages.push(...safetyChecks(deps.userId, positions, now, toggles));

  // Exit rules (exit-rules.ts): close the trades whose armed level was reached.
  try {
    hotHandMessages.push(...(await runExitRules(deps.userId, deps.executor, now)));
  } catch (err) {
    console.error(`[trade-monitor] ${deps.userId}: exit rules failed:`, err);
  }
  for (const msg of hotHandMessages) {
    try {
      await deps.notify(msg);
    } catch (err) {
      console.error(`[trade-monitor] ${deps.userId}: account-level alert failed to send:`, err);
    }
  }

  // Only return the categories that were actually delivered, so callers/tests see real behaviour.
  return delivered;
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

const feedState = new Map<string, { staleSince?: number; told?: boolean }>();

/** Whether MT5 has gone quiet with trades open. Tells once per outage, and once when it's back. */
export function feedCheck(userId: string, openTrades: number, now: number): { stale: boolean; recovered?: boolean; message?: string } {
  const updatedAt = getLastKnownAccountSnapshot(userId)?.updatedAt;
  const st = feedState.get(userId) ?? {};
  const stale = openTrades > 0 && typeof updatedAt === "number" && now - updatedAt > FEED_STALE_MS;
  if (stale) {
    if (st.told) return { stale: true };
    feedState.set(userId, { staleSince: updatedAt, told: true });
    return {
      stale: true,
      message:
        `📡 MONITOR BLIND\n\nMT5 hasn't reported for ${fmtDuration(now - (updatedAt as number))} and you have ${openTrades} open trade${openTrades === 1 ? "" : "s"}. ` +
        `I can't see prices, so no alerts, exit rules or reviews until it's back. Check the terminal: is it running, connected, with the EA on the chart and Algo Trading on? Your broker-side stops still work.`,
    };
  }
  if (st.told) {
    feedState.set(userId, {});
    return { stale: false, recovered: true, message: `📡 MT5 is reporting again -- I'm watching your trades.` };
  }
  return { stale: false };
}

const heatState = new Map<string, number>();

/** Account heat: the total floating loss against the balance, or every open trade losing at once. */
export function portfolioHeat(userId: string, positions: { ticket: string; symbol: string; type: string; pnl?: number }[], now: number): string | null {
  const withPnl = positions.filter((p) => typeof p.pnl === "number");
  if (withPnl.length < 2) return null;
  const total = withPnl.reduce((a, p) => a + (p.pnl as number), 0);
  const losers = withPnl.filter((p) => (p.pnl as number) < 0);
  const balance = getLastKnownAccountSnapshot(userId)?.balance;
  const pct = balance && balance > 0 ? (-total / balance) * 100 : undefined;
  const hot = total < 0 && ((pct !== undefined && pct >= PORTFOLIO_HEAT_PCT) || (losers.length >= PORTFOLIO_LOSERS_MIN && losers.length === withPnl.length));
  if (!hot) return null;
  const last = heatState.get(userId);
  if (last !== undefined && now - last < PORTFOLIO_COOLDOWN_MS) return null;
  heatState.set(userId, now);
  const worst = [...losers].sort((a, b) => (a.pnl as number) - (b.pnl as number)).slice(0, 3);
  const buys = withPnl.filter((p) => p.type === "buy").length;
  const sells = withPnl.length - buys;
  const oneSided = buys === 0 || sells === 0;
  return (
    `🌡️ ACCOUNT HEAT\n\n${withPnl.length} open trades, ${losers.length} losing -- together ${money(total)}${pct !== undefined ? ` (${pct.toFixed(1)}% of the balance)` : ""}.\n` +
    `Worst: ${worst.map((p) => `${p.symbol} #${p.ticket} ${money(p.pnl as number)}`).join(", ")}\n` +
    `${oneSided ? `All ${buys ? "BUYS" : "SELLS"} -- this is one bet placed ${withPnl.length} times, not ${withPnl.length} bets.` : `${buys} buys / ${sells} sells.`}\n\n` +
    `Self-check: which of these would you still take right now? Cut the weakest instead of adding, and no new trades until the heat comes down.`
  );
}

/** Test seam. */
export function resetSweepState(): void {
  feedState.clear();
  heatState.clear();
  resetSafetyState();
}
