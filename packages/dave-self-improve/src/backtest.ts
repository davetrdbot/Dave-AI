/**
 * Step 17.7: before proposing activation of a new or changed trading
 * strategy, Dave must run MULTIPLE backtests and present the range of
 * results -- enforced for real in code (throws below the minimum), not
 * just implied by convention.
 *
 * Per the master prompt's own constraint (never author actual trading
 * rules/strategy content), `BacktestStrategy` is an injected function
 * type -- this module has no idea what a strategy IS or DOES. It only
 * owns: running whatever strategy function it's given across multiple
 * historical windows, and honestly presenting the spread of results.
 * The real strategy logic is the user's own uploaded rules file, wired
 * in wherever Dave's agent loop calls this with it.
 */

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface BacktestTrade {
  entryPrice: number;
  exitPrice: number;
  pnl: number;
}

export type BacktestStrategy = (candles: Candle[]) => BacktestTrade[];

export interface HistoricalWindow {
  label: string;
  candles: Candle[];
}

export interface BacktestSummary {
  windowLabel: string;
  tradeCount: number;
  totalPnl: number;
  winRate: number;
}

export interface BacktestRange {
  results: BacktestSummary[];
  minPnl: number;
  maxPnl: number;
  avgPnl: number;
  minWinRate: number;
  maxWinRate: number;
}

export const MIN_BACKTESTS = 2;

export class InsufficientBacktestsError extends Error {
  constructor(public readonly count: number) {
    super(`only ${count} backtest window(s) given -- Dave must run MULTIPLE backtests (at least ${MIN_BACKTESTS}) before proposing a strategy change, never just one`);
    this.name = "InsufficientBacktestsError";
  }
}

function summarize(label: string, trades: BacktestTrade[]): BacktestSummary {
  const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);
  const wins = trades.filter((t) => t.pnl > 0).length;
  return { windowLabel: label, tradeCount: trades.length, totalPnl, winRate: trades.length ? wins / trades.length : 0 };
}

/** Hard gate: throws below MIN_BACKTESTS rather than silently running whatever it was given. */
export function runMultipleBacktests(strategy: BacktestStrategy, windows: HistoricalWindow[]): BacktestRange {
  if (windows.length < MIN_BACKTESTS) throw new InsufficientBacktestsError(windows.length);

  const results = windows.map((w) => summarize(w.label, strategy(w.candles)));
  const pnls = results.map((r) => r.totalPnl);
  const winRates = results.map((r) => r.winRate);
  return {
    results,
    minPnl: Math.min(...pnls),
    maxPnl: Math.max(...pnls),
    avgPnl: pnls.reduce((a, b) => a + b, 0) / pnls.length,
    minWinRate: Math.min(...winRates),
    maxWinRate: Math.max(...winRates),
  };
}

/** A real range summary, not a single number -- what actually gets shown to the user before a strategy-change approval prompt. */
export function formatBacktestRange(range: BacktestRange): string {
  const lines = range.results.map((r) => `  - ${r.windowLabel}: ${r.tradeCount} trades, PnL ${r.totalPnl >= 0 ? "+" : ""}${r.totalPnl.toFixed(2)}, win rate ${(r.winRate * 100).toFixed(0)}%`);
  return [
    `Ran ${range.results.length} backtests across different historical windows:`,
    ...lines,
    `PnL range: ${range.minPnl.toFixed(2)} to ${range.maxPnl.toFixed(2)} (avg ${range.avgPnl.toFixed(2)})`,
    `Win rate range: ${(range.minWinRate * 100).toFixed(0)}% to ${(range.maxWinRate * 100).toFixed(0)}%`,
  ].join("\n");
}
