import { breakevenStop, tradeModify, type TradeExecutor } from "@dave/trading";

/**
 * Dave never kills a trade (the trader: "the bot just like killing trades ... I don't like it").
 * Seen live before this: BOOM_200 closed at -0.76R, stop not hit, "premise invalid" -- and price then
 * ran to the take profit; and winners cut early "near target" or part-closed "to bank something".
 *
 * When Dave decides ON HIS OWN (a scan, an action, a self-review) to close or part-close an open
 * trade, it is never done:
 *  - in profit: the stop goes to true breakeven instead -- it can't lose, and it still runs to target;
 *  - losing: it stays open -- the stop IS the invalidation the plan priced in.
 * Only the stop loss, the take profit, or the trader closes a trade. Deleting an unfilled pending
 * order is not a close and still works; so does anything the trader asks for in chat.
 */

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
  const dir = p.type.toLowerCase().startsWith("sell") ? -1 : 1;
  const inProfit = typeof price === "number" && price > 0 && dir * (price - p.openPrice) > 0;
  // The trader (2 Oct): "it's not compulsory it must hit TP -- sometimes it should close a trade
  // when in profit". A winner may be banked; only a losing trade is held to its stop.
  if (inProfit) return { close: true };
  return {
    close: false,
    inProfit: false,
    why: `#${p.ticket} ${p.symbol} stays open -- Dave doesn't close trades; ${typeof p.sl === "number" && p.sl > 0 ? `the stop (${p.sl}) is where the idea is wrong` : "set a stop with MODIFY if it has none"}, and markets fake out before the real move`,
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
