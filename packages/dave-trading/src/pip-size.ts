/**
 * Real bug fixed (the trader: "find bugs in my code"). autonomous-tick.ts hardcoded
 * `const pip = 0.0001` and used it for BOTH the fixed-pip stop loss and the fixed-pip take
 * profit. That constant is only correct for 4-digit forex pairs. It is wrong for JPY pairs, wrong
 * for metals, and catastrophically wrong for the synthetic indices that make up this trader's
 * ENTIRE watchlist -- their live prices run into the hundreds of thousands (CRASH_200 at 615,490;
 * VOL_10 at 1,407,421 in the same day's logs).
 *
 * The real consequence, on those instruments:
 *   - a 40-pip take profit resolves to 0.004 away from entry -- effectively AT the entry price,
 *     so the trade closes instantly for nothing, minus spread. Nothing guards the TP path.
 *   - a 15-pip stop loss resolves to 0.0015 away, which the ATR tightness check then rejects --
 *     so switching fixed-pip stops on would make Dave refuse every single trade instead.
 *
 * The EA already knows each symbol's true pip size (ea/DaveEA.mq5's g_aPip) and already reports
 * `spread_pips` next to the raw bid/ask on the price endpoint. That makes the real pip size
 * derivable from data ALREADY flowing, with no EA change and no recompile: the same spread
 * expressed both in price terms and in pips gives the conversion directly.
 *
 * Where it genuinely cannot be derived, this returns undefined rather than guessing. A wrong pip
 * size here is wrong by orders of magnitude, so the caller must refuse to place a fixed-pip
 * order rather than silently place a nonsense one.
 */

export interface PipSizeSource {
  bid?: number;
  ask?: number;
  /** The EA's own spread, expressed in real pips for this symbol (A_Pips/g_aPip). */
  spread_pips?: number;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * The real pip size for this symbol, derived from the EA's own numbers, or undefined when it
 * genuinely cannot be established.
 *
 * `spread_pips` arrives rounded to 2 decimals, which introduces a small proportional error --
 * irrelevant at stop-distance scale, but it does mean a spread reported as 0.00 pips carries no
 * information at all, so that case is refused rather than divided by.
 */
export function derivePipSize(price: PipSizeSource | undefined): number | undefined {
  if (!price) return undefined;
  const { bid, ask, spread_pips: spreadPips } = price;
  if (!isPositiveFinite(bid) || !isPositiveFinite(ask)) return undefined;
  if (!isPositiveFinite(spreadPips)) return undefined;
  const spread = ask - bid;
  if (!isPositiveFinite(spread)) return undefined;
  const pip = spread / spreadPips;
  if (!isPositiveFinite(pip)) return undefined;
  return pip;
}
