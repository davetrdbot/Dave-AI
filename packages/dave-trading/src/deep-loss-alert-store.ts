import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendSettingsLogEntry } from "./settings-log.js";

/**
 * Real feature (the trader, explicit: "set the deep loss alert -- but default should be 50%").
 *
 * The Self-Aware Trade Monitor fires a DEEP-LOSS alert when an open position has travelled a
 * fraction of the way from its entry toward its stop -- i.e. how close it is to being stopped out.
 * That fraction was a hardcoded 0.5 (DEEP_LOSS_SL_PROGRESS in dave-agent-loop). This makes it a
 * real, per-user setting, persisted and read fresh on every sweep, in exactly the same file-backed
 * shape as every other setting in this package (risk-reward-guard.ts is the twin of this file).
 *
 * Stored as a FRACTION in [0,1] (0.5 = halfway to the stop). The tool layer talks to the trader in
 * percent (50) and converts; the store itself is the fraction the state machine compares against.
 * 50% stays the DEFAULT only -- a scalper on a tight stop may want to hear about it earlier (30%),
 * a trader who wants to give a position more room may want it later (70%).
 */

/** Default: halfway from entry to the stop. Kept in lockstep with DEEP_LOSS_SL_PROGRESS in
 *  dave-agent-loop's trade-monitor-store (that package can't import this one without a cycle, so
 *  the number is duplicated deliberately; both are 0.5). */
export const DEFAULT_DEEP_LOSS_PROGRESS = 0.5;

/** Bounds as fractions. Never 0 (would alert the instant a trade ticks red) and never >=1 (would
 *  only alert once the stop is already hit, i.e. never in practice). */
export const MIN_DEEP_LOSS_PROGRESS = 0.05; // 5%
export const MAX_DEEP_LOSS_PROGRESS = 0.95; // 95%

export class InvalidDeepLossAlertError extends Error {
  constructor(percent: number) {
    super(
      `The deep-loss alert must be a percentage between ${Math.round(MIN_DEEP_LOSS_PROGRESS * 100)} and ${Math.round(
        MAX_DEEP_LOSS_PROGRESS * 100
      )} -- got ${percent}. It's how far a trade has moved from entry toward its stop before Dave warns you: ` +
        `50 means "halfway to the stop", a smaller number warns earlier, a larger one warns later.`
    );
    this.name = "InvalidDeepLossAlertError";
  }
}

function deepLossPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "deep-loss-alert.json");
}

/** The user's own configured deep-loss fraction, or the default when they have never set one. */
export function getDeepLossAlertProgress(userId: string): number {
  const path = deepLossPath(userId);
  if (!existsSync(path)) return DEFAULT_DEEP_LOSS_PROGRESS;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { deepLossProgress?: number };
    const value = parsed.deepLossProgress;
    // A corrupt or out-of-range file must never silently disable or over-fire the alert, nor throw
    // inside the sweep -- fall back to the safe default instead.
    return typeof value === "number" && Number.isFinite(value) && value >= MIN_DEEP_LOSS_PROGRESS && value <= MAX_DEEP_LOSS_PROGRESS
      ? value
      : DEFAULT_DEEP_LOSS_PROGRESS;
  } catch {
    return DEFAULT_DEEP_LOSS_PROGRESS;
  }
}

/** Convenience for the UI/live-context: the setting as a whole-number percent (e.g. 50). */
export function getDeepLossAlertPercent(userId: string): number {
  return Math.round(getDeepLossAlertProgress(userId) * 100);
}

/** Set the deep-loss alert from a whole-number percent (what the trader actually says: "40%"). */
export function setDeepLossAlertPercent(userId: string, percent: number): { deepLossPercent: number; deepLossProgress: number } {
  const fraction = Number.isFinite(percent) ? percent / 100 : NaN;
  if (!Number.isFinite(fraction) || fraction < MIN_DEEP_LOSS_PROGRESS || fraction > MAX_DEEP_LOSS_PROGRESS) {
    throw new InvalidDeepLossAlertError(percent);
  }
  const previous = getDeepLossAlertPercent(userId);
  const path = deepLossPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify({ deepLossProgress: fraction }, null, 2), "utf8");
  appendSettingsLogEntry(userId, "deepLossAlertPercent", previous, Math.round(fraction * 100));
  return { deepLossPercent: Math.round(fraction * 100), deepLossProgress: fraction };
}
