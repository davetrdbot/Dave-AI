import { isTradingHalted, startTradingLoop, resumeTradingLoop } from "@dave/safety";

/**
 * Real gap fixed (user: "you forgot /start_trading and /stop_trading, and the loop for
 * start_trading"): dave-safety's interrupts.ts already had a real tradingLoop state machine
 * (idle/running/halted) and a real startTradingLoop()/resumeTradingLoop(), but nothing in
 * production ever called them -- there was no actual autonomous cycle, and no command to turn
 * one on. This is that real cycle's scheduling layer: a genuine setInterval per owner (this is
 * a single-owner bot, but keyed anyway rather than assuming), gated on dave-safety's own halted
 * state so /stop or /panic still instantly silences it without this module needing to know why.
 */

const activeIntervals = new Map<string, ReturnType<typeof setInterval>>();

/** Real cadence between autonomous scan cycles -- independent of the EA's own 6s heartbeat/tick,
 * this is how often Dave actively re-evaluates the active pair group for a genuine setup. */
export const TRADING_LOOP_INTERVAL_MS = 5 * 60 * 1000;

export function isAutonomousTradingRunning(ownerUserId: string): boolean {
  return activeIntervals.has(ownerUserId);
}

/** Returns false (no-op) if a loop is already running for this user -- /start_trading twice
 * must not stack two intervals. */
export function startAutonomousTradingLoop(ownerUserId: string, runCycle: () => Promise<void>, intervalMs: number = TRADING_LOOP_INTERVAL_MS): boolean {
  if (activeIntervals.has(ownerUserId)) return false;
  startTradingLoop(ownerUserId);
  const handle = setInterval(() => {
    if (isTradingHalted(ownerUserId)) return; // /stop or /panic fired since the last tick -- skip, stay armed for a real /stop_trading
    void runCycle();
  }, intervalMs);
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
  resumeTradingLoop(ownerUserId);
  return true;
}
