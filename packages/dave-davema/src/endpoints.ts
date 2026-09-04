/** Step 7.1: the full 46-endpoint DAVEMA register, from the provided skill doc. */
export const DAVEMA_ENDPOINTS = [
  "price", "structure", "zones", "liquidity", "trend", "momentum", "volatility", "volume",
  "ichimoku", "fibonacci", "candles", "patterns", "ict", "wyckoff", "divergence", "session",
  "pivots", "levels", "orderflow", "confluence", "risk_metrics", "synthetic", "elliott",
  "correlation", "strength", "heatmap", "fractal", "harmonic", "mean_reversion", "tape",
  "seasonality", "spread_analysis", "gann", "market_profile", "tape_flow", "macro", "news",
  "sentiment", "regime", "backtest", "swing", "order_blocks", "inducement", "premium_discount",
  "all", "ping",
] as const;

export type DavemaEndpoint = (typeof DAVEMA_ENDPOINTS)[number];

/** Format from the docs: `sk_live_` + 48 hex characters. */
const KEY_PATTERN = /^sk_live_[0-9a-f]{48}$/;

export function isValidDavemaKeyFormat(key: string): boolean {
  return KEY_PATTERN.test(key.trim());
}

export function maskDavemaKey(key: string): string {
  if (key.length < 12) return "****";
  return `${key.slice(0, 12)}${"*".repeat(Math.max(0, key.length - 16))}${key.slice(-4)}`;
}
