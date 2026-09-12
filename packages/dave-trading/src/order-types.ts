/**
 * Step 10.2: all 6 real MT5 order types.
 */
export type OrderType = "buy" | "sell" | "buy_limit" | "sell_limit" | "buy_stop" | "sell_stop";

export const ORDER_TYPES: OrderType[] = ["buy", "sell", "buy_limit", "sell_limit", "buy_stop", "sell_stop"];

export function isPendingOrderType(type: OrderType): boolean {
  return type !== "buy" && type !== "sell";
}

export interface OrderRequest {
  symbol: string;
  type: OrderType;
  lots: number;
  price?: number; // required for pending types unless resolvable below
  sl?: number;
  tp?: number;
}

export type EntryPriceResolution =
  | { resolved: true; price: number; source: "explicit" | "calculated" }
  | { resolved: false; needsPrompt: true; reason: string };

/**
 * Step 10.2: "if a limit/stop order lacks an entry price, Dave
 * calculates one or asks -- never silently fails." This module only
 * does the mechanical part: use an explicit price if given, or a
 * caller-supplied reference price + offset (e.g. from DAVEMA analysis
 * the agent already ran) if given. It deliberately does NOT invent
 * *which* offset or reference level to use -- that would be authoring
 * trading strategy, which is the user's rules file's job, never Dave's
 * to invent (per the master prompt). If neither is available, the
 * caller must prompt the user -- this function makes that explicit
 * instead of ever silently defaulting or failing.
 */
export function resolveEntryPrice(
  order: Pick<OrderRequest, "type" | "price">,
  opts: { referencePrice?: number; offsetPips?: number; pipSize?: number } = {}
): EntryPriceResolution {
  if (!isPendingOrderType(order.type)) {
    // Market orders execute at the live price -- nothing to resolve here.
    return { resolved: true, price: order.price ?? 0, source: "explicit" };
  }
  if (order.price !== undefined) {
    return { resolved: true, price: order.price, source: "explicit" };
  }
  if (opts.referencePrice !== undefined && opts.offsetPips !== undefined) {
    const pip = opts.pipSize ?? 0.0001;
    const direction = order.type === "buy_limit" || order.type === "sell_stop" ? -1 : 1;
    const price = opts.referencePrice + direction * opts.offsetPips * pip;
    return { resolved: true, price, source: "calculated" };
  }
  return {
    resolved: false,
    needsPrompt: true,
    reason: `${order.type} needs an entry price and none was given or calculable -- ask the user for one.`,
  };
}

/**
 * Real gap fixed (user, live: "the bot doesn't consider the sl... it usually put a sl that will
 * kill a trade in instance" -- the user's own explicit correction: this is the bot's own judgment
 * problem, not a broker/EA minimum-distance issue, so the fix is sized to real current volatility
 * (ATR), never a fixed pip number that's wrong for at least some instrument). An SL closer than
 * `minAtrMultiple` * ATR is unreasonably tight for essentially any instrument -- reject-only, never
 * widens or otherwise changes the SL/entry/direction/TP the model chose.
 */
export function isSlTooTight(referencePrice: number, sl: number, atr: number, minAtrMultiple = 0.25): boolean {
  return atr > 0 && Math.abs(referencePrice - sl) < atr * minAtrMultiple;
}

export function validateOrder(order: OrderRequest): string[] {
  const errors: string[] = [];
  if (!order.symbol) errors.push("symbol is required");
  if (!ORDER_TYPES.includes(order.type)) errors.push(`unknown order type "${order.type}"`);
  if (!(order.lots > 0)) errors.push("lots must be a positive number");
  if (isPendingOrderType(order.type) && order.price === undefined) {
    errors.push(`${order.type} requires a price (use resolveEntryPrice first)`);
  }
  return errors;
}
