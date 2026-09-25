import type { ParsedSignal } from "./store.js";

/**
 * Is this signal still takeable, and as what order? (the trader: "the bot should be time conscious
 * -- not when the entry has already passed, or placing a trade from 2 days ago".)
 *
 * Pure: the caller supplies the live price and the clock, so every rule here is testable.
 *
 * Rules, in order:
 *   - Too old: posted longer ago than the trader's limit -> skip.
 *   - Price already beyond the stop, or already at TP1 -> the trade has happened without us.
 *   - Entry passed: price has already travelled more than PASSED_FRACTION of the way from the
 *     entry to TP1 -> chasing it would be a worse trade than the one signalled.
 *   - Otherwise: a limit/stop whose price is still on the right side of the market is placed as
 *     that pending order; anything else (a market call, or a limit price has already reached) goes
 *     in at market.
 * TP1 goes to the broker; TP2 is where the trade is moved once TP1 is nearly there (manager.ts).
 */

export const PASSED_FRACTION = 0.3;

export type Placement =
  | { ok: true; type: "buy" | "sell" | "buy_limit" | "sell_limit" | "buy_stop" | "sell_stop"; price?: number; entry: number; note: string }
  | { ok: false; reason: string };

export function planPlacement(signal: ParsedSignal, livePrice: number, postedAt: number, now: number, maxAgeMinutes: number): Placement {
  const ageMin = (now - postedAt) / 60_000;
  if (ageMin > maxAgeMinutes) return { ok: false, reason: `posted ${Math.round(ageMin)} min ago -- older than your ${maxAgeMinutes}-minute limit` };

  const dir = signal.side === "buy" ? 1 : -1;
  const { sl, tp1 } = signal;
  if (!(dir * (tp1 - sl) > 0)) return { ok: false, reason: `the levels don't make sense for a ${signal.side} (SL ${sl}, TP1 ${tp1})` };
  if (dir * (livePrice - sl) <= 0) return { ok: false, reason: `price ${livePrice} is already past the stop loss ${sl}` };
  if (dir * (livePrice - tp1) >= 0) return { ok: false, reason: `price ${livePrice} already reached TP1 ${tp1} -- the move happened without us` };

  const entry = signal.entry ?? livePrice;
  if (dir * (entry - sl) <= 0 || dir * (tp1 - entry) <= 0) return { ok: false, reason: `the entry ${entry} isn't between the stop ${sl} and TP1 ${tp1}` };

  const side = signal.side;
  // A pending order is only valid on its own side of the market: a buy limit below price, a buy
  // stop above it (mirrored for sells). It waits for its own price, so "entry passed" can't apply.
  if (signal.orderKind === "limit" && signal.entry !== undefined && dir * (livePrice - signal.entry) > 0) {
    return { ok: true, type: `${side}_limit`, price: signal.entry, entry: signal.entry, note: `${side} limit at ${signal.entry} (price ${livePrice})` };
  }
  if (signal.orderKind === "stop" && signal.entry !== undefined && dir * (signal.entry - livePrice) > 0) {
    return { ok: true, type: `${side}_stop`, price: signal.entry, entry: signal.entry, note: `${side} stop at ${signal.entry} (price ${livePrice})` };
  }

  // Going in at market: only while price is still near the signalled entry.
  const travelled = (dir * (livePrice - entry)) / Math.abs(tp1 - entry);
  if (travelled > PASSED_FRACTION) {
    return { ok: false, reason: `entry passed -- price ${livePrice} is already ${Math.round(travelled * 100)}% of the way from the entry ${entry} to TP1` };
  }
  return { ok: true, type: side, entry: livePrice, note: signal.orderKind === "market" ? `market ${side} at ~${livePrice}` : `the ${signal.orderKind} level ${signal.entry} is already reached -- market ${side} at ~${livePrice}` };
}

/** Risk:reward to TP1 from where the trade actually goes in. */
export function rewardToRisk(entry: number, sl: number, tp1: number): number {
  const risk = Math.abs(entry - sl);
  return risk > 0 ? Math.abs(tp1 - entry) / risk : 0;
}
