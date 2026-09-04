import type { DavemaClient } from "./client.js";

/**
 * Step 7.3: correlation check before sizing any trade, per the skill
 * doc's own recipe and IDENTITY.md ("Check correlation before sizing --
 * don't stack risk on pairs that are secretly moving together").
 */

export interface CorrelationData {
  ret_5bar: number;
  ret_20bar: number;
  vs_eurusd: number;
  corr_label: string;
  vs_dxy: number;
  risk_on: boolean;
  safe_haven: boolean;
  momentum_sync: boolean;
  positive_pairs: string[];
  negative_pairs: string[];
}

export interface StrengthData {
  base: string;
  quote: string;
  bias: string;
  strongest_currency: string;
  weakest_currency: string;
  best_pair_to_trade: string;
}

export interface CorrelationCheckResult {
  symbol: string;
  correlation: CorrelationData;
  strength: StrengthData;
  warnHighCorrelation: boolean;
  reason: string;
}

const HIGH_CORRELATION_THRESHOLD = 0.7;

/**
 * Pulls /correlation and /strength for a symbol and decides whether
 * sizing this trade would stack risk on something already correlated
 * with existing exposure -- callers pass the symbol(s) of currently
 * open positions to compare against.
 */
export async function checkCorrelationBeforeSizing(
  client: DavemaClient,
  symbol: string,
  tf = "M15"
): Promise<CorrelationCheckResult> {
  const [correlation, strength] = await Promise.all([
    client.data<CorrelationData>("correlation", symbol, tf),
    client.data<StrengthData>("strength", symbol, tf),
  ]);

  // Real bug fixed here: vs_eurusd is trivially ~1.0 when symbol IS
  // EURUSD itself -- comparing a symbol's correlation against itself and
  // "warning" that EURUSD is highly correlated with EURUSD is nonsense,
  // not a real risk signal.
  const isEurusdItself = symbol.toUpperCase() === "EURUSD";
  const warnHighCorrelation = !isEurusdItself && Math.abs(correlation.vs_eurusd) > HIGH_CORRELATION_THRESHOLD;
  const reason = isEurusdItself
    ? `${symbol} is the correlation benchmark itself -- no self-comparison to make.`
    : warnHighCorrelation
      ? `${symbol} is ${(correlation.vs_eurusd * 100).toFixed(0)}% correlated with EURUSD (${correlation.corr_label}) -- sizing should account for shared exposure.`
      : `${symbol} correlation with EURUSD is within normal range (${(correlation.vs_eurusd * 100).toFixed(0)}%).`;

  return { symbol, correlation, strength, warnHighCorrelation, reason };
}
