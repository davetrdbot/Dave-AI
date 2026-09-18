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
 * Where `spread_pips` is missing or unusable it falls back to the EA's OWN digit rule, ported --
 * see quotePrecisionPipSize. Only with no usable price at all does it return undefined, and the
 * callers then refuse the trade rather than placing a fixed-pip order off a guessed scale.
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
  if (!isPositiveFinite(bid) || !isPositiveFinite(ask)) return quotePrecisionPipSize(price);
  const spread = ask - bid;
  if (isPositiveFinite(spreadPips) && isPositiveFinite(spread)) {
    const pip = spread / spreadPips;
    if (isPositiveFinite(pip)) return pip;
  }
  return quotePrecisionPipSize(price);
}

/**
 * Fallback when the EA's `spread_pips` is absent or unusable (a zero spread, a spread rounded to
 * 0.00 pips, an older EA build, a quote carrying only a close).
 *
 * Real regression fixed, caught by step15 before this shipped: the first version of this module
 * returned undefined in that case, and the callers then SKIPPED applying the user's fixed-pip
 * SL/TP entirely -- so a quote without spread_pips produced a live position with no stop at all.
 * That is the worse failure by a wide margin: a slightly mis-scaled stop costs a bounded amount,
 * an absent stop is unbounded. This is not a guess either -- it is the EA's own rule, ported:
 * ea/DaveEA.mq5 computes `g_aPip = (g_aDigits == 3 || g_aDigits == 5) ? g_aPoint * 10 : g_aPoint`,
 * i.e. the 3/5-decimal convention where a pip is ten points, and one point otherwise. The quote's
 * own decimal precision gives the digit count directly.
 */
function quotePrecisionPipSize(price: PipSizeSource): number | undefined {
  const samples = [price.bid, price.ask].filter(isPositiveFinite);
  if (samples.length === 0) return undefined;
  // The MAXIMUM precision across both legs, not the first available one. A trailing zero is
  // trimmed in a JS number's printed form, so a genuine 4-decimal quote can arrive as bid 1.085
  // (reading as 3 decimals) beside ask 1.0852 (4). Taking the first leg there produced 0.01
  // instead of 0.0001 -- off by 100x, exactly the class of error this whole module exists to
  // prevent. The pair together reveals the broker's real digit count.
  const decimals = Math.max(...samples.map(decimalPlaces));
  // Parsed from exponential form rather than computed with Math.pow: Math.pow(10, -4) yields
  // 0.00009999999999999999, while Number("1e-4") is the same double as the literal 0.0001. The
  // value ends up in real SL/TP prices, so it should not carry avoidable noise.
  const places = decimals === 3 || decimals === 5 ? decimals - 1 : decimals;
  const pip = Number(`1e-${places}`);
  return isPositiveFinite(pip) ? pip : undefined;
}

function decimalPlaces(value: number): number {
  // Rendered rather than bit-inspected: a quote arrives as a decimal number from the EA, and its
  // printed form is what carries the broker's real digit count.
  const text = String(value);
  if (text.includes("e") || text.includes("E")) return 0; // exponential form carries no useful precision here
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
}
