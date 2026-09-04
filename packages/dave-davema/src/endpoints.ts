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

/**
 * Format from the docs: `sk_live_` + 48 hex characters. The docs never
 * actually show a real key's casing (only the placeholder "sk_live_xxxxx"),
 * so accepting both cases defensively -- a lowercase-only pattern would
 * silently reject a genuinely valid key if the real generator ever
 * produces uppercase hex digits.
 */
const KEY_PATTERN = /^sk_live_[0-9a-fA-F]{48}$/;

export function isValidDavemaKeyFormat(key: string): boolean {
  return KEY_PATTERN.test(key.trim());
}

/** Finds a DAVEMA key anywhere inside a longer message, not just when the whole message is the key. */
export function extractDavemaKey(message: string): string | undefined {
  const match = message.match(/sk_live_[0-9a-fA-F]{48}/);
  return match?.[0];
}

export function maskDavemaKey(key: string): string {
  if (key.length < 12) return "****";
  return `${key.slice(0, 12)}${"*".repeat(Math.max(0, key.length - 16))}${key.slice(-4)}`;
}
