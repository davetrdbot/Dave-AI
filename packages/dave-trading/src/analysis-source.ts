/**
 * Item 5 real gap fixed (DAVEMA retirement, user: "the bot is currently asking the user for a
 * DAVEMA API key, which means something still references it"): dave-trading's live trade path
 * (find_setup, trade_execute) used to depend directly on `DavemaClient`, a real HTTP client that
 * still made genuine network calls to the retired external DAVEMA API. This small interface
 * decouples dave-trading from any specific market-data source -- dave-ea-bridge (which already
 * depends on dave-trading, so the reverse dependency isn't possible without a cycle) provides the
 * real implementation, backed by the connected MT5 EA's own on-demand analysis (requestAnalysis).
 */
export interface AnalysisSource {
  get<T = unknown>(endpoint: string, symbol: string, timeframe?: string, opts?: { timeoutMs?: number }): Promise<T>;
}
