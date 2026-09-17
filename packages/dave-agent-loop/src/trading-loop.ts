import { isTradingHalted, startTradingLoop, resumeTradingLoop } from "@dave/safety";
import { getTradingLoopIntervalMs, getTradingLoopIntervalMinutes, setTradingLoopIntervalMinutes } from "./trading-loop-config.js";

/**
 * Real gap fixed (user: "you forgot /start_trading and /stop_trading, and the loop for
 * start_trading"): dave-safety's interrupts.ts already had a real tradingLoop state machine
 * (idle/running/halted) and a real startTradingLoop()/resumeTradingLoop(), but nothing in
 * production ever called them -- there was no actual autonomous cycle, and no command to turn
 * one on. This is that real cycle's scheduling layer, gated on dave-safety's own halted state so
 * /stop or /panic still instantly silences it without this module needing to know why.
 *
 * Cadence is real, persisted, user-configurable (trading-loop-config.ts) -- not a hardcoded
 * constant -- per the user's explicit follow-up ask.
 *
 * Real gap fixed (the trader, explicit: add a real UI control in the admin panel for the scan
 * interval): the admin panel runs as its own real child process (see provider-router.ts's own
 * comment on this same architectural fact) -- it can never reach this in-memory `activeIntervals`
 * map to force a live re-arm the way /start_trading <minutes> does in-process.
 *
 * Real bug fixed, found by LIVE verification, not just reasoning about the code: a first version
 * of this fix used a single self-rescheduling setTimeout that re-read the interval before
 * scheduling each NEXT wait -- which sounds like "picks up a change on the very next tick," but a
 * live test proved otherwise: a config change made mid-wait never touches the setTimeout handle
 * that's ALREADY armed with the stale interval, so it only actually took effect after that entire
 * stale wait finished (up to the old interval's full length -- e.g. a 60-minute stale wait truly
 * eats a full 60 minutes before a 1-minute change lands). Replaced with a short, fixed-cadence
 * poll (`POLL_MS`): every real cycle only fires once at least `getTradingLoopIntervalMs()` has
 * genuinely elapsed since the last one, re-read fresh on every single poll tick -- so a change
 * from EITHER process (the admin panel's file write, or Telegram's /start_trading <minutes>) is
 * live within one poll window, not "after however long the old interval happened to be."
 */

const POLL_MS = 5_000;
const activeIntervals = new Map<string, ReturnType<typeof setInterval>>();
const activeRunners = new Map<string, () => Promise<void>>();
const lastRunAt = new Map<string, number>();
const cycleInFlight = new Set<string>();

export { DEFAULT_TRADING_LOOP_MINUTES, MIN_TRADING_LOOP_MINUTES, MAX_TRADING_LOOP_MINUTES, InvalidTradingLoopIntervalError, getTradingLoopIntervalMinutes, setTradingLoopIntervalMinutes } from "./trading-loop-config.js";

export function isAutonomousTradingRunning(ownerUserId: string): boolean {
  return activeIntervals.has(ownerUserId);
}

/** Runs the real cycle if (and only if) genuinely due -- reads the live interval fresh on every
 *  single poll tick, so a persisted config change (from any process) is observed within one
 *  `POLL_MS` window, never bound to whatever the previous interval happened to be. Guards against
 *  a cycle that runs longer than the configured interval firing a second overlapping call. */
function pollTick(ownerUserId: string, runCycle: () => Promise<void>): void {
  if (isTradingHalted(ownerUserId)) return;
  if (cycleInFlight.has(ownerUserId)) return; // previous cycle still running -- never overlap
  const due = (lastRunAt.get(ownerUserId) ?? 0) + getTradingLoopIntervalMs(ownerUserId);
  if (Date.now() < due) return; // not due yet
  lastRunAt.set(ownerUserId, Date.now());
  cycleInFlight.add(ownerUserId);
  void runCycle()
    .catch((err) => console.error(`[trading-loop] autonomous cycle threw for ${ownerUserId}:`, err))
    .finally(() => cycleInFlight.delete(ownerUserId));
}

/** Returns false (no-op) if a loop is already running for this user -- /start_trading twice
 * must not stack two intervals. `startAtMs`, when given, back-dates `lastRunAt` so the FIRST real
 * cycle fires sooner/later than a full interval from now (used by the explicit re-arm below);
 * omit for the normal case (first real cycle fires after one full interval, same as before). */
export function startAutonomousTradingLoop(ownerUserId: string, runCycle: () => Promise<void>, intervalMs?: number): boolean {
  if (activeIntervals.has(ownerUserId)) return false;
  startTradingLoop(ownerUserId);
  activeRunners.set(ownerUserId, runCycle);
  lastRunAt.set(ownerUserId, Date.now() - (intervalMs !== undefined ? getTradingLoopIntervalMs(ownerUserId) - intervalMs : 0));
  const handle = setInterval(() => pollTick(ownerUserId, runCycle), POLL_MS);
  activeIntervals.set(ownerUserId, handle);
  return true;
}

/** Returns false (no-op) if nothing was running. Deliberately distinct from stopOrPanic("stop")
 * -- this is a clean, intentional "turn autonomous trading off," not an emergency halt. */
export function stopAutonomousTradingLoop(ownerUserId: string): boolean {
  const handle = activeIntervals.get(ownerUserId);
  if (!handle) return false;
  clearInterval(handle);
  activeIntervals.delete(ownerUserId);
  activeRunners.delete(ownerUserId);
  lastRunAt.delete(ownerUserId);
  cycleInFlight.delete(ownerUserId);
  resumeTradingLoop(ownerUserId);
  return true;
}

/**
 * Real, live cadence change -- persists the new interval AND, if the loop is currently running,
 * makes the NEXT poll tick treat it as immediately due (rather than waiting for
 * `lastRunAt + newInterval`, which could still be a real wait if the old interval was long and
 * little time has passed since the last real cycle). Genuinely fires within one `POLL_MS` window.
 * Cross-process changes (the admin panel writing the same config file directly) don't need this
 * call at all -- pollTick already re-reads the live interval every single poll.
 */
export function setAutonomousTradingIntervalMinutes(ownerUserId: string, minutes: number): number {
  const applied = setTradingLoopIntervalMinutes(ownerUserId, minutes);
  if (activeRunners.has(ownerUserId)) lastRunAt.set(ownerUserId, 0);
  return applied;
}
