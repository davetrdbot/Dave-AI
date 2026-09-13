import { isForexSymbol } from "@dave/trading";
import type { EaPosition } from "@dave/ea-bridge";

/**
 * Real gap fixed (user: SMC/ICT audit -- "HTF bias same as HTF & LTF" alignment, and "a single
 * real number multi-timeframe confluence score" flagged as missing). The EA's own `get_all_analysis`
 * only ever computes against ONE timeframe per call -- there is no EA endpoint that reasons across
 * timeframes. But autonomous-tick.ts already fetches all 6 real timeframes every single cycle
 * (`suiteByTimeframe`) purely to hand the model 6 separate objects and hope it cross-references them
 * itself. This computes a REAL, structured cross-timeframe read from that SAME already-fetched data
 * -- zero new EA calls, zero MQL5 changes -- so alignment/confluence is a genuine computed fact the
 * model is handed, not something it has to remember to reconstruct itself from 6 raw blobs.
 */

export interface TimeframeTrendSample {
  tf: string;
  bias: string | undefined;
  score: number | undefined;
}

function extractTrendSample(tf: string, data: unknown): TimeframeTrendSample {
  if (!data || typeof data !== "object") return { tf, bias: undefined, score: undefined };
  const trend = (data as Record<string, unknown>).trend;
  if (!trend || typeof trend !== "object") return { tf, bias: undefined, score: undefined };
  const t = trend as Record<string, unknown>;
  return { tf, bias: typeof t.bias === "string" ? t.bias : undefined, score: typeof t.score === "number" ? t.score : undefined };
}

function isBull(bias: string | undefined): boolean {
  return bias === "BULL" || bias === "STRONG_BULL";
}
function isBear(bias: string | undefined): boolean {
  return bias === "BEAR" || bias === "STRONG_BEAR";
}

/**
 * Real HTF/LTF alignment: genuinely counts how many of the real fetched timeframes agree on
 * direction (BULL-family vs BEAR-family), reports the real count and a plain-language verdict, and
 * separately calls out whether the two REAL boundary reads (the lowest and highest timeframe
 * actually fetched this cycle -- LTF and HTF) agree, since that's the specific pairing the user
 * asked about, not just an average across all six.
 */
export function computeMtfAlignment(suiteByTimeframe: Array<{ tf: string; data: unknown }>): string {
  const samples = suiteByTimeframe.map(({ tf, data }) => extractTrendSample(tf, data));
  const withBias = samples.filter((s) => s.bias !== undefined);
  if (withBias.length === 0) return "MTF ALIGNMENT: no real trend data available this cycle across any timeframe.";

  const bullCount = withBias.filter((s) => isBull(s.bias)).length;
  const bearCount = withBias.filter((s) => isBear(s.bias)).length;
  const neutralCount = withBias.length - bullCount - bearCount;
  const perTf = withBias.map((s) => `${s.tf}=${s.bias}`).join(" ");

  const ltf = withBias[0];
  const htf = withBias[withBias.length - 1];
  const ltfHtfAgree = withBias.length > 1 && ((isBull(ltf.bias) && isBull(htf.bias)) || (isBear(ltf.bias) && isBear(htf.bias)));
  const boundaryLine =
    withBias.length > 1
      ? `LTF (${ltf.tf}=${ltf.bias}) vs HTF (${htf.tf}=${htf.bias}): ${ltfHtfAgree ? "AGREE" : "DISAGREE"}`
      : "only one timeframe fetched -- no real LTF/HTF pairing to compare";

  const verdict =
    bullCount === withBias.length ? "FULL BULL ALIGNMENT" :
    bearCount === withBias.length ? "FULL BEAR ALIGNMENT" :
    bullCount > bearCount ? `MOSTLY BULL (${bullCount}/${withBias.length})` :
    bearCount > bullCount ? `MOSTLY BEAR (${bearCount}/${withBias.length})` :
    "GENUINELY MIXED, no real majority";

  return `MTF ALIGNMENT: ${verdict} -- ${perTf}${neutralCount > 0 ? ` (${neutralCount} neutral)` : ""}. ${boundaryLine}.`;
}

/**
 * Real multi-timeframe confluence: a single number, the mean of each real fetched timeframe's own
 * trend.score (-5..+5), so "how aligned is this read across time" collapses to one comparable
 * figure instead of the model having to average 6 numbers itself under time pressure every cycle.
 */
export function computeMtfConfluenceScore(suiteByTimeframe: Array<{ tf: string; data: unknown }>): string {
  const samples = suiteByTimeframe.map(({ tf, data }) => extractTrendSample(tf, data)).filter((s) => s.score !== undefined) as Array<{ tf: string; bias: string | undefined; score: number }>;
  if (samples.length === 0) return "MTF CONFLUENCE SCORE: no real trend score data available this cycle.";
  const mean = samples.reduce((sum, s) => sum + s.score, 0) / samples.length;
  const spread = Math.max(...samples.map((s) => s.score)) - Math.min(...samples.map((s) => s.score));
  return `MTF CONFLUENCE SCORE: ${mean.toFixed(1)} (range -5..+5, mean across ${samples.length} real fetched timeframes, spread ${spread.toFixed(1)} -- a low spread means genuine agreement, a high spread means the timeframes are fighting each other).`;
}

/**
 * Real gap fixed (user: SMC/ICT audit -- "no basket/correlation risk check... can be long 3
 * synthetic pairs that all move together and have no idea it's triple-exposed"). Synthetic indices
 * are engineered to be independent of each other and of real markets (trading.md's own tradable-
 * universe section) -- real, computable basket risk instead lives in forex/metals, where two open
 * positions sharing a base or quote currency in the same real net direction double up the same real
 * currency exposure (e.g. long EURUSD + long GBPUSD = short USD twice). Computed purely from the
 * real open-positions list already fetched every cycle -- no new EA call, no correlation-endpoint
 * round trip per open symbol.
 */
export function computeBasketCurrencyRisk(positions: EaPosition[], groupIdFor: (symbol: string) => string | null | undefined): string | null {
  const forexPositions = positions.filter((p) => isForexSymbol(p.symbol, groupIdFor(p.symbol)));
  if (forexPositions.length < 2) return null;

  const exposures = new Map<string, { long: string[]; short: string[] }>();
  for (const p of forexPositions) {
    const upper = p.symbol.toUpperCase();
    const base = upper.slice(0, 3);
    const quote = upper.slice(3, 6);
    const isBuy = p.type === "buy";
    // Long a pair = long its base currency, short its quote currency (and vice versa for short).
    for (const [ccy, longSide] of [[base, isBuy], [quote, !isBuy]] as const) {
      const entry = exposures.get(ccy) ?? { long: [], short: [] };
      (longSide ? entry.long : entry.short).push(`${p.symbol} #${p.ticket}`);
      exposures.set(ccy, entry);
    }
  }

  const stacked = [...exposures.entries()].filter(([, e]) => e.long.length + e.short.length >= 2 && (e.long.length >= 2 || e.short.length >= 2));
  if (stacked.length === 0) return null;

  const lines = stacked.map(([ccy, e]) => {
    const stackedSide = e.long.length >= 2 ? `LONG ${ccy} via ${e.long.join(", ")}` : `SHORT ${ccy} via ${e.short.join(", ")}`;
    return stackedSide;
  });
  return `BASKET CURRENCY RISK: real, stacked same-direction exposure to the same currency across multiple open forex positions -- ${lines.join("; ")}. This is real doubled risk on one currency move, not two independent bets.`;
}

/**
 * Real gap fixed (user: SMC/ICT audit -- "no spread-widening-around-news detection... nothing
 * combines them into a warning"). Both `spread_analysis` and `news` are already real, already-fetched
 * fields inside the same per-timeframe suite -- this just genuinely reads both and states plainly
 * when they compound (spread already costly AND a real high-impact event is genuinely imminent),
 * instead of leaving the model to notice the connection between two separate objects itself.
 */
export function computeSpreadNewsRisk(suiteData: unknown): string | null {
  if (!suiteData || typeof suiteData !== "object") return null;
  const d = suiteData as Record<string, unknown>;
  const spreadAnalysis = d.spread_analysis as Record<string, unknown> | undefined;
  const news = d.news as Record<string, unknown> | undefined;
  if (!spreadAnalysis || !news) return null;
  const costly = spreadAnalysis.cost_rating === "HIGH" || spreadAnalysis.tradeable === false;
  const newsImminent = typeof news.minutes_to_next === "number" && news.minutes_to_next >= 0 && news.minutes_to_next < 30 && typeof news.high_impact_count === "number" && news.high_impact_count > 0;
  if (!costly && !newsImminent) return null;
  if (costly && newsImminent) {
    return `SPREAD+NEWS RISK: real spread cost is already ${spreadAnalysis.cost_rating ?? "elevated"} AND a real high-impact news event is ${news.minutes_to_next} minute(s) away -- both real risks compounding, genuinely poor conditions to enter right now.`;
  }
  if (costly) return `SPREAD RISK: real spread cost is ${spreadAnalysis.cost_rating ?? "elevated"} right now (tradeable=${spreadAnalysis.tradeable}) -- factor real execution cost into any entry.`;
  return `NEWS RISK: a real high-impact news event is ${news.minutes_to_next} minute(s) away -- expect real volatility/spread widening imminently.`;
}
