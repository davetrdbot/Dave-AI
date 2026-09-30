import { breakevenStop, tradeModify, type TradeExecutor } from "@dave/trading";

/**
 * Hold to the plan (the trader: "the AI was scared and he closed it while the thing was actually
 * profitable ... the market is deceiving sometimes"). Seen live: BOOM_200 closed at -0.76R, stop
 * not hit, "premise invalid" -- a fear exit on a move the stop was placed to survive.
 *
 * When Dave closes a trade ON HIS OWN (a scan, an action, a self-review) before its stop:
 *  - losing, stop still ahead: not closed -- the stop IS the invalidation the plan priced in;
 *  - in profit: not closed -- the stop goes to true breakeven instead (it can't turn into a loss,
 *    and it keeps its chance to run to target);
 *  - within reach of target (85%+ of the way), or no stop at all, or no live price: closing is fine.
 * Partial closes, exit rules he armed in advance, and anything the trader asks for are untouched.
 */

export const NEAR_TARGET = 0.85;

export interface HoldPosition {
  ticket: string;
  symbol: string;
  type: string;
  openPrice: number;
  currentPrice?: number;
  sl?: number;
  tp?: number;
  spread?: number;
  digits?: number;
  stopsLevel?: number;
}

export type HoldVerdict = { close: true } | { close: false; inProfit: boolean; why: string };

export function holdOrClose(p: HoldPosition): HoldVerdict {
  const price = p.currentPrice;
  if (typeof price !== "number" || !(price > 0) || typeof p.sl !== "number" || !(p.sl > 0)) return { close: true };
  const dir = p.type.toLowerCase().startsWith("sell") ? -1 : 1;
  const move = dir * (price - p.openPrice);
  if (typeof p.tp === "number" && p.tp > 0) {
    const toTarget = dir * (p.tp - p.openPrice);
    if (toTarget > 0 && move / toTarget >= NEAR_TARGET) return { close: true };
  }
  if (move > 0) {
    return { close: false, inProfit: true, why: `#${p.ticket} ${p.symbol} is in profit -- not closed out of caution; the stop goes to breakeven so it can't lose and can still run to target` };
  }
  return {
    close: false,
    inProfit: false,
    why: `#${p.ticket} ${p.symbol} hasn't hit its stop (${p.sl}) -- the stop is where the idea is wrong; markets fake out before the real move, so it stays open`,
  };
}

/** For a refused close on a winner: moves the stop to true breakeven if it isn't protecting yet. */
export async function protectInstead(executor: TradeExecutor, p: HoldPosition): Promise<string> {
  const dir = p.type.toLowerCase().startsWith("sell") ? -1 : 1;
  const be = breakevenStop({ side: dir === 1 ? "buy" : "sell", openPrice: p.openPrice, currentPrice: p.currentPrice, spread: p.spread, digits: p.digits, stopsLevel: p.stopsLevel });
  const alreadySafe = typeof p.sl === "number" && dir * (p.sl - be.level) >= 0;
  if (alreadySafe) return `stop already protects it (${p.sl})`;
  if (!be.ok) return "too close to entry to protect yet -- holding";
  await tradeModify(executor, p.ticket, { sl: be.level });
  return `stop moved to breakeven ${be.level}`;
}
