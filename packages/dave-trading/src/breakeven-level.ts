/**
 * Where a "breakeven" stop really has to go.
 *
 * The trader, live: "the trade was in profit for long, breakeven should close at 0.00 / 0.01 -- it
 * closed at -0.006". A stop sitting exactly on the entry price fires on the OTHER side of the
 * spread (a sell's stop on the ask, a buy's on the bid), so it closes a spread's worth in loss.
 * True breakeven is entry + spread + one point in the trade's favour. With the broker's minimum
 * stop distance respected, and never placed past the current price.
 */
export interface BreakevenInput {
  side: "buy" | "sell";
  openPrice: number;
  /** Price now (the position's current price as MT5 reports it). */
  currentPrice?: number;
  /** Live ask - bid, in price (EA 3.3+). */
  spread?: number;
  /** Symbol decimals; the "one point" of buffer is 10^-digits. */
  digits?: number;
  /** Broker's minimum distance between price and a stop, in price (EA 3.3+). */
  stopsLevel?: number;
  /** Extra distance in the trade's favour, in price (optional). */
  offset?: number;
}

export type BreakevenResult = { ok: true; level: number } | { ok: false; level: number; reason: string };

export function breakevenStop(p: BreakevenInput): BreakevenResult {
  const digits = p.digits !== undefined && p.digits >= 0 && p.digits <= 10 ? p.digits : undefined;
  const point = digits !== undefined ? 10 ** -digits : 0;
  const buffer = Math.max(0, p.spread ?? 0) + point + Math.max(0, p.offset ?? 0);
  const raw = p.side === "buy" ? p.openPrice + buffer : p.openPrice - buffer;
  const level = digits !== undefined ? Number(raw.toFixed(digits)) : raw;
  const price = p.currentPrice;
  if (price === undefined) return { ok: false, level, reason: "no current price from MT5 yet" };
  const gap = Math.max(0, p.stopsLevel ?? 0);
  const clear = p.side === "buy" ? price - gap > level : price + gap < level;
  if (!clear) return { ok: false, level, reason: `not far enough in profit yet -- breakeven after the spread is ${level}, price is ${price}` };
  return { ok: true, level };
}
