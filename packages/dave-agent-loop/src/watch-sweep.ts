import {
  listActiveWatches,
  symbolsToPoll,
  evaluateWatch,
  markWatchTriggered,
  buildWatchTriggeredMessage,
  type BackgroundWatch,
} from "@dave/trading";
import type { AnalysisSource } from "@dave/trading";

/**
 * The runtime half of Dave's background checks (see background-watch.ts for the store and the
 * trader's own spec). This is what makes a marked level a genuinely BACKGROUND thing rather than
 * something that only exists while a turn happens to be running: it sweeps on its own timer,
 * fires once per watch, and hands the alert back carrying Dave's original reason verbatim.
 *
 * Deliberately NOT driven off the EA heartbeat. The heartbeat carries the account and open
 * positions, not a quote for an arbitrary symbol Dave has merely marked, so a level on a symbol
 * with no open position would never be checked at all. This asks for a real price per distinct
 * watched symbol instead, on its own slower cadence, so a handful of marks costs a handful of EA
 * round trips a minute rather than competing with the trading loop on every 8-second beat.
 */

/** One sweep per 30s: fast enough that a level alert is timely, slow enough that 20 watches cost
 *  well under one EA price call per second. The trading loop shares this EA. */
const SWEEP_INTERVAL_MS = 30_000;

export interface WatchSweepDeps {
  userId: string;
  analysis: AnalysisSource;
  /** Sends the alert. Kept as a callback so this module never imports a Telegram client, and so a
   *  test can assert exactly what would have been sent. */
  notify: (text: string) => Promise<void>;
}

interface PriceQuote {
  bid?: number;
  ask?: number;
  close?: number;
}

/** Mid-price where both sides are known, so a level is not triggered a spread early by whichever
 *  side happens to be nearer it. */
export function midPrice(quote: PriceQuote | undefined): number | undefined {
  if (!quote) return undefined;
  const { bid, ask, close } = quote;
  if (typeof bid === "number" && typeof ask === "number" && bid > 0 && ask > 0) return (bid + ask) / 2;
  for (const candidate of [bid, ask, close]) {
    if (typeof candidate === "number" && candidate > 0) return candidate;
  }
  return undefined;
}

/**
 * One real sweep. Exported so it is directly testable and so a caller can force a sweep without
 * waiting for the timer. Returns the watches that genuinely fired this pass.
 */
export async function runWatchSweep(deps: WatchSweepDeps): Promise<BackgroundWatch[]> {
  const symbols = symbolsToPoll(deps.userId);
  if (symbols.length === 0) return [];

  const prices = new Map<string, number>();
  for (const symbol of symbols) {
    try {
      const quote = await deps.analysis.get<PriceQuote>("price", symbol);
      const price = midPrice(quote);
      if (price !== undefined) prices.set(symbol, price);
    } catch (err) {
      // One unreachable symbol must never stop the other watches from being evaluated, and must
      // never take down the sweep timer.
      console.error(`[watch-sweep] ${deps.userId}: could not price ${symbol} this sweep:`, err);
    }
  }

  const fired: BackgroundWatch[] = [];
  for (const watch of listActiveWatches(deps.userId)) {
    const price = prices.get(watch.symbol);
    if (price === undefined) continue;
    if (!evaluateWatch(watch, price)) continue;
    // markWatchTriggered flips the status and returns undefined if something already claimed it,
    // so two overlapping sweeps can never double-alert on one level.
    const triggered = markWatchTriggered(deps.userId, watch.id, price);
    if (!triggered) continue;
    fired.push(triggered);
    try {
      await deps.notify(buildWatchTriggeredMessage(triggered));
    } catch (err) {
      console.error(`[watch-sweep] ${deps.userId}: watch ${watch.id} fired but the alert failed to send:`, err);
    }
  }
  return fired;
}

const activeSweeps = new Map<string, ReturnType<typeof setInterval>>();

/** Returns false if a sweep is already running for this user -- never stacks two timers. */
export function startWatchSweep(deps: WatchSweepDeps, intervalMs = SWEEP_INTERVAL_MS): boolean {
  if (activeSweeps.has(deps.userId)) return false;
  const handle = setInterval(() => {
    // The sweep is deliberately fire-and-forget on the timer, so a slow EA round trip never
    // delays the next tick -- but it MUST carry its own catch. An unhandled rejection here would
    // kill the whole process (see main.ts's fatal-guard for why this codebase takes that
    // seriously), over a price check.
    void runWatchSweep(deps).catch((err) => console.error(`[watch-sweep] ${deps.userId}: sweep failed:`, err));
  }, intervalMs);
  activeSweeps.set(deps.userId, handle);
  return true;
}

export function stopWatchSweep(userId: string): boolean {
  const handle = activeSweeps.get(userId);
  if (!handle) return false;
  clearInterval(handle);
  activeSweeps.delete(userId);
  return true;
}
