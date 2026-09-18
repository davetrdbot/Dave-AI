import type { TradeExecutor } from "./trade-executor.js";
import type { OrderRequest } from "./order-types.js";
import { tradeExecute } from "./trade-execute.js";

/**
 * Real bug fixed (the trader, live, caught in production logs the moment the autonomous loop
 * finally started working): Dave found a genuine BOOM_100 setup -- 62% confidence, all six
 * timeframes STRONG_BULL in agreement, textbook H4 breakout -- sized it himself, sent it, and the
 * broker rejected it outright with "failed: not enough money". The cycle then threw and died.
 *
 * Root cause: nothing ever checked the order was affordable before sending it. Dave picks his own
 * lot size (autonomous-tick.ts's `decision.lots`, prompted to "size to win, not timidly") against
 * a balance he can see -- but the margin a lot actually COSTS depends on the symbol's contract
 * size and the account leverage, which only MT5 knows and which is never sent to him. On a $100
 * account trading synthetic indices priced in the hundreds of thousands, that guess is
 * unaffordable essentially every time, so this failure would repeat on EVERY good setup: a bot
 * that analyses perfectly and can never actually trade.
 *
 * Rather than guess the contract spec, this asks the only authority that really knows -- the
 * broker -- and steps the size down until it accepts. A margin rejection is the one broker error
 * that is genuinely retryable at a smaller size; every other error (bad symbol, market closed,
 * invalid stops) is a real problem that must surface untouched, so only margin wording is caught.
 */

/** MT5's near-universal minimum tradable volume. Deliberately the floor, not a guess at the
 *  symbol's own minimum -- if the broker still refuses at this size, no size will work. */
export const ABSOLUTE_MIN_LOTS = 0.01;

/** Each retry halves the size, so this reaches 1/16th of the original before giving up -- enough
 *  to cross the gap from a wildly oversized guess to something a small account can carry, without
 *  spending the whole cycle in EA round trips. */
const DEFAULT_MAX_ATTEMPTS = 5;

export class InsufficientMarginError extends Error {
  constructor(
    readonly symbol: string,
    readonly triedLots: number[],
    readonly brokerMessage: string
  ) {
    super(
      `${symbol}: the account cannot afford this trade at any size -- tried ${triedLots.join(", ")} lots, ` +
        `broker still refused (${brokerMessage}).`
    );
    this.name = "InsufficientMarginError";
  }
}

/**
 * A broker refusing for lack of margin says so in prose, and the wording varies by broker/build
 * (MT5's own retcode text is "No money", Headway's EA surfaced it live as "not enough money").
 * Matched loosely on purpose -- a missed match just means the old behavior (the error surfaces
 * untouched), never a wrong-sized order.
 */
export function isMarginRejection(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /not enough money|no money|insufficient (funds|margin)|margin/.test(message);
}

/** Halve, rounded DOWN to a whole 0.01 step -- rounding down matters, since rounding up could
 *  re-request a size the broker just refused. */
function nextSmallerLots(lots: number, minLots: number): number {
  return Math.max(minLots, Math.floor((lots / 2) * 100) / 100);
}

/**
 * The real sizes to try, largest first, ALWAYS ending at the floor.
 *
 * Real bug fixed by this function's own test before it ever shipped: a plain halving loop under a
 * fixed attempt cap ran 1 -> 0.5 -> 0.25 -> 0.12 -> 0.06 and gave up there, never actually trying
 * the 0.01 minimum -- so an account that genuinely could afford the floor would be told it
 * "cannot afford this trade at any size" and a perfectly good setup would be skipped. Halving
 * alone converges far too slowly to reach the floor inside any sane number of broker round trips
 * (each one costs a real EA heartbeat), so the ladder is built upfront and the floor is appended
 * as the guaranteed last rung.
 */
export function buildLotLadder(requestedLots: number, minLots: number, maxAttempts: number): number[] {
  if (requestedLots <= minLots) return [Math.max(requestedLots, minLots)];
  const ladder = [requestedLots];
  let current = requestedLots;
  while (ladder.length < maxAttempts - 1) {
    const next = nextSmallerLots(current, minLots);
    if (next >= current || next <= minLots) break;
    ladder.push(next);
    current = next;
  }
  ladder.push(minLots);
  return ladder;
}

export interface MarginAwareResult {
  ticket: string;
  /** What Dave originally asked for. */
  requestedLots: number;
  /** What the broker actually accepted. */
  placedLots: number;
  /** True when the trade only went through because the size was stepped down. */
  reducedForMargin: boolean;
}

/**
 * Places the order, stepping the lot size down on a margin rejection until the broker accepts it
 * or the absolute minimum is refused too. Any non-margin error propagates unchanged.
 */
export async function tradeExecuteWithMarginRetry(
  executor: TradeExecutor,
  order: OrderRequest,
  options: { minLots?: number; maxAttempts?: number } = {}
): Promise<MarginAwareResult> {
  const minLots = options.minLots ?? ABSOLUTE_MIN_LOTS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const ladder = buildLotLadder(order.lots, minLots, maxAttempts);
  const tried: number[] = [];
  let lastBrokerMessage = "no broker response recorded";

  for (const lots of ladder) {
    try {
      const placed = await tradeExecute(executor, { ...order, lots });
      return { ticket: placed.ticket, requestedLots: order.lots, placedLots: lots, reducedForMargin: lots < order.lots };
    } catch (err) {
      if (!isMarginRejection(err)) throw err;
      tried.push(lots);
      lastBrokerMessage = err instanceof Error ? err.message : String(err);
    }
  }
  throw new InsufficientMarginError(order.symbol, tried, lastBrokerMessage);
}
