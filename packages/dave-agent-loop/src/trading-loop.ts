import { isTradingHalted, startTradingLoop, resumeTradingLoop } from "@dave/safety";
import { getTradingLoopIntervalMs, getTradingLoopIntervalMinutes, setTradingLoopIntervalMinutes } from "./trading-loop-config.js";

/**
 * Real gap fixed (user: "you forgot /start_trading and /stop_trading, and the loop for
 * start_trading"): dave-safety's interrupts.ts already had a real tradingLoop state machine
 * (idle/running/halted) and a real startTradingLoop()/resumeTradingLoop(), but nothing in
 * production ever called them -- there was no actual autonomous cycle, and no command to turn
 * one on. This is that real cycle's scheduling layer: a genuine setInterval per owner (this is
 * a single-owner bot, but keyed anyway rather than assuming), gated on dave-safety's own halted
 * state so /stop or /panic still instantly silences it without this module needing to know why.
 *
 * Cadence is real, persisted, user-configurable (trading-loop-config.ts) -- not a hardcoded
 * constant -- per the user's explicit follow-up ask.
 */

const activeIntervals = new Map<string, ReturnType<typeof setInterval>>();
const activeRunners = new Map<string, () => Promise<void>>();

export { DEFAULT_TRADING_LOOP_MINUTES, MIN_TRADING_LOOP_MINUTES, MAX_TRADING_LOOP_MINUTES, InvalidTradingLoopIntervalError, getTradingLoopIntervalMinutes, setTradingLoopIntervalMinutes } from "./trading-loop-config.js";

export function isAutonomousTradingRunning(ownerUserId: string): boolean {
  return activeIntervals.has(ownerUserId);
}

function arm(ownerUserId: string, runCycle: () => Promise<void>, intervalMs: number): void {
  const handle = setInterval(() => {
    if (isTradingHalted(ownerUserId)) return; // /stop or /panic fired since the last tick -- skip, stay armed for a real /stop_trading
    void runCycle();
  }, intervalMs);
  activeIntervals.set(ownerUserId, handle);
  activeRunners.set(ownerUserId, runCycle);
}

/** Returns false (no-op) if a loop is already running for this user -- /start_trading twice
 * must not stack two intervals. Uses the user's own configured cadence (trading-loop-config.ts)
 * unless intervalMs is explicitly overridden. */
export function startAutonomousTradingLoop(ownerUserId: string, runCycle: () => Promise<void>, intervalMs?: number): boolean {
  if (activeIntervals.has(ownerUserId)) return false;
  startTradingLoop(ownerUserId);
  arm(ownerUserId, runCycle, intervalMs ?? getTradingLoopIntervalMs(ownerUserId));
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
  resumeTradingLoop(ownerUserId);
  return true;
}

/**
 * Real, live cadence change -- persists the new interval AND, if the loop is currently running,
 * re-arms it with the new cadence immediately (tearing down and rebuilding the real setInterval)
 * rather than requiring a stop/start round trip or waiting for the old interval to happen to
 * pick up a config file it never re-reads mid-flight.
 */
export function setAutonomousTradingIntervalMinutes(ownerUserId: string, minutes: number): number {
  const applied = setTradingLoopIntervalMinutes(ownerUserId, minutes);
  const runner = activeRunners.get(ownerUserId);
  if (runner) {
    const handle = activeIntervals.get(ownerUserId);
    if (handle) clearInterval(handle);
    arm(ownerUserId, runner, applied * 60_000);
  }
  return applied;
}
