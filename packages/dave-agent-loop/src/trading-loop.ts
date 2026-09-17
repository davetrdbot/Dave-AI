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
 * map to force a live re-arm the way /start_trading <minutes> does in-process. A single
 * self-rescheduling setTimeout (instead of a setInterval armed once with a captured interval)
 * reads the real persisted cadence FRESH before every tick, so a change written to the shared
 * config file from EITHER process -- the admin panel's new interval control, or Telegram's
 * /start_trading <minutes> -- takes effect on the very next tick, cross-process, with no explicit
 * re-arm call required. setAutonomousTradingIntervalMinutes below still exists for the case where
 * a user wants it to apply sooner than the current wait would otherwise allow (a genuine early
 * re-arm, not just "eventually correct").
 */

const activeIntervals = new Map<string, ReturnType<typeof setTimeout>>();
const activeRunners = new Map<string, () => Promise<void>>();

export { DEFAULT_TRADING_LOOP_MINUTES, MIN_TRADING_LOOP_MINUTES, MAX_TRADING_LOOP_MINUTES, InvalidTradingLoopIntervalError, getTradingLoopIntervalMinutes, setTradingLoopIntervalMinutes } from "./trading-loop-config.js";

export function isAutonomousTradingRunning(ownerUserId: string): boolean {
  return activeIntervals.has(ownerUserId);
}

/** Schedules the NEXT tick only, reading the real persisted interval fresh right before doing so
 *  -- never a fixed cadence captured once at start. `overrideMs`, when given, is honored for just
 *  this one scheduling call (a one-shot start-up override); every call after that always reads
 *  the live config. */
function scheduleNextTick(ownerUserId: string, runCycle: () => Promise<void>, overrideMs?: number): void {
  const intervalMs = overrideMs ?? getTradingLoopIntervalMs(ownerUserId);
  const handle = setTimeout(() => {
    void (async () => {
      if (!activeIntervals.has(ownerUserId)) return; // stopped while this tick was scheduled
      if (!isTradingHalted(ownerUserId)) {
        try {
          await runCycle();
        } catch (err) {
          console.error(`[trading-loop] autonomous cycle threw for ${ownerUserId}:`, err);
        }
      }
      if (activeIntervals.has(ownerUserId)) scheduleNextTick(ownerUserId, runCycle);
    })();
  }, intervalMs);
  activeIntervals.set(ownerUserId, handle);
}

/** Returns false (no-op) if a loop is already running for this user -- /start_trading twice
 * must not stack two intervals. Uses the user's own configured cadence (trading-loop-config.ts)
 * unless intervalMs is explicitly overridden for this one start-up tick. */
export function startAutonomousTradingLoop(ownerUserId: string, runCycle: () => Promise<void>, intervalMs?: number): boolean {
  if (activeIntervals.has(ownerUserId)) return false;
  startTradingLoop(ownerUserId);
  activeRunners.set(ownerUserId, runCycle);
  scheduleNextTick(ownerUserId, runCycle, intervalMs);
  return true;
}

/** Returns false (no-op) if nothing was running. Deliberately distinct from stopOrPanic("stop")
 * -- this is a clean, intentional "turn autonomous trading off," not an emergency halt. */
export function stopAutonomousTradingLoop(ownerUserId: string): boolean {
  const handle = activeIntervals.get(ownerUserId);
  if (!handle) return false;
  clearTimeout(handle);
  activeIntervals.delete(ownerUserId);
  activeRunners.delete(ownerUserId);
  resumeTradingLoop(ownerUserId);
  return true;
}

/**
 * Real, live cadence change -- persists the new interval AND, if the loop is currently running,
 * re-arms it with the new cadence immediately (tearing down the pending tick and rescheduling)
 * rather than waiting out whatever's left of the OLD wait first. Cross-process changes (the admin
 * panel writing the same config file directly) don't need this -- scheduleNextTick already reads
 * fresh every tick -- this is only for "make it apply right now, in THIS process."
 */
export function setAutonomousTradingIntervalMinutes(ownerUserId: string, minutes: number): number {
  const applied = setTradingLoopIntervalMinutes(ownerUserId, minutes);
  const runner = activeRunners.get(ownerUserId);
  if (runner) {
    const handle = activeIntervals.get(ownerUserId);
    if (handle) clearTimeout(handle);
    scheduleNextTick(ownerUserId, runner, applied * 60_000);
  }
  return applied;
}
