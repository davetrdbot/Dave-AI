import type { DaveDatabase } from "@dave/db";
import { getRiskSettings } from "@dave/trading";
import { getTodaysWinRateSummary } from "@dave/feedback";
import { getLastKnownAccountSnapshot } from "@dave/ea-bridge";
import { stopOrPanic } from "@dave/safety";

/**
 * Item 6 real gap fixed (user's reference pattern: "drawdown cap (auto-pauses trading entirely
 * if hit, notifies the user)"). `maxDailyLossPct` existed as a real settable field on
 * RiskSettings, but nothing anywhere ever read it -- confirmed via a full grep before this fix,
 * a real gap distinct from the protected-limit machinery that just stores the number.
 */
export interface DrawdownCheckResult {
  breached: boolean;
  lossPct?: number;
  limitPct?: number;
}

export function checkDrawdown(db: DaveDatabase, userId: string): DrawdownCheckResult {
  const risk = getRiskSettings(userId);
  if (risk.maxDailyLossPct === undefined) return { breached: false };
  const snapshot = getLastKnownAccountSnapshot(userId);
  if (!snapshot || snapshot.balance <= 0) return { breached: false }; // no real balance to measure against yet
  const summary = getTodaysWinRateSummary(db, userId);
  if (summary.netPnl >= 0) return { breached: false };
  const lossPct = (Math.abs(summary.netPnl) / snapshot.balance) * 100;
  return { breached: lossPct >= risk.maxDailyLossPct, lossPct, limitPct: risk.maxDailyLossPct };
}

// Per-user, per-real-UTC-day: has the breach already been paused + notified? Process-lifetime
// only (matches the other same-day dedup patterns in this codebase) -- a restart re-evaluates,
// which is the honest behavior since maxDailyLossPct resets its real meaning at UTC midnight.
const notifiedOn = new Map<string, string>();

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Returns true if trading was (or already had been) paused for a real drawdown breach this UTC
 * day -- callers use this to skip the rest of the cycle. Pauses via the same real halt mechanism
 * `/stop` uses (stopOrPanic), and notifies exactly once per real breach-day, never every cycle.
 */
export async function enforceDrawdownLimit(db: DaveDatabase, userId: string, notify: (text: string) => Promise<void>): Promise<boolean> {
  const result = checkDrawdown(db, userId);
  if (!result.breached) return false;
  const today = todayKey();
  if (notifiedOn.get(userId) === today) return true; // already paused + notified today
  notifiedOn.set(userId, today);
  stopOrPanic(userId, "stop");
  await notify(
    `🛑 Daily loss limit hit -- down ${result.lossPct!.toFixed(1)}% today (limit ${result.limitPct}%). ` +
      `Autonomous trading is now paused for real, not just a warning. /start_trading to resume once you're ready.`
  );
  return true;
}
