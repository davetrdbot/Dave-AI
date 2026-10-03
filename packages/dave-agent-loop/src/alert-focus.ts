import { requestAlertFocus } from "./autonomous-tick-state.js";
import { isAutonomousTradingEnabled } from "./autonomous-trading-state.js";
import { runScanSoon, preemptRoutineTick } from "./trading-loop.js";
import { wakeFromSelfPause } from "./self-pause.js";
import { publishActivity } from "./activity-bus.js";

/**
 * An alert makes mode 2 act, not just read about it later (the trader: "the bot just marked a level
 * and it didn't do anything -- same as the self aware alert"). Before, a level hit or a trade alert
 * was only a line in the NEXT scan's prompt, and that scan analysed whatever pair came next in the
 * rotation -- never a pair with an open trade at all. Now the alert's pair is queued first and a
 * scan starts within seconds, with the alert on top of its prompt.
 */

/** One alert scan per pair per this long -- a burst of alerts on one trade is one look, not five. */
export const ALERT_FOCUS_COOLDOWN_MS = 2 * 60_000;
const lastFocus = new Map<string, number>();

export function focusScanOnAlert(userId: string, symbol: string, alertText: string, now = Date.now()): boolean {
  if (!symbol || !isAutonomousTradingEnabled(userId)) return false;
  // Resting? Anything worth an alert wakes Dave straight away.
  if (wakeFromSelfPause(userId)) publishActivity(userId, "loop", "self_pause_end", { text: `▶ Woke up for ${symbol}: ${alertText.replace(/\s+/g, " ").slice(0, 160)}`, symbol });
  const key = `${userId}:${symbol.toUpperCase()}`;
  const last = lastFocus.get(key);
  if (last !== undefined && now - last < ALERT_FOCUS_COOLDOWN_MS) return false;
  lastFocus.set(key, now);
  requestAlertFocus(userId, symbol, alertText, now);
  const soon = runScanSoon(userId);
  // A routine scan of another pair is cut short so this one starts within seconds, not after it.
  const cut = soon && preemptRoutineTick(userId);
  console.log(`[alert-focus] ${userId}: ${symbol} queued for a scan${soon ? " now" : " (next scan)"}${cut ? " -- routine scan stopped for it" : ""} -- ${alertText.replace(/\s+/g, " ").slice(0, 120)}`);
  return true;
}

/** Test seam. */
export function resetAlertFocus(): void {
  lastFocus.clear();
}
