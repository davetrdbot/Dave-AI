import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Real feature (user, live: "add a feature in the settings that the user can configure the get
 * all analysis so they will select among endpoints to sent to the bot and the timeframe, and a
 * default button to send all"). Defaults to sending everything (matches today's real behavior,
 * confirmed correct against the user's own original spec) -- a user only ever narrows this
 * deliberately, never accidentally.
 */
export const ALL_ANALYSIS_TIMEFRAMES = ["M1", "M3", "M5", "M15", "H1", "H4"] as const;

/** The real, authoritative list of "all"-endpoint analysis categories -- matches the endpoint id
 *  each analysisTool() entry in dave-ea-bridge/src/tools.ts registers (the second constructor
 *  argument), not a re-invented or approximate list. */
export const ALL_ANALYSIS_ENDPOINTS = [
  "trend",
  "momentum",
  "volatility",
  "price",
  "structure",
  "zones",
  "liquidity",
  "volume",
  "ichimoku",
  "fibonacci",
  "candles",
  "patterns",
  "ict",
  "wyckoff",
  "divergence",
  "session",
  "pivots",
  "levels",
  "orderflow",
  "confluence",
  "risk_metrics",
  "synthetic",
  "elliott",
  "correlation",
  "strength",
  "heatmap",
  "fractal",
  "harmonic",
  "mean_reversion",
  "tape",
  "tape_flow",
  "seasonality",
  "spread_analysis",
  "gann",
  "market_profile",
  "macro",
  "news",
  "sentiment",
  "regime",
  "backtest",
  "swing",
  "order_blocks",
  "inducement",
  "premium_discount",
] as const;

export interface AnalysisConfig {
  mode: "all" | "custom";
  timeframes: string[];
  endpoints: string[];
}

const DEFAULT_CONFIG: AnalysisConfig = { mode: "all", timeframes: [...ALL_ANALYSIS_TIMEFRAMES], endpoints: [...ALL_ANALYSIS_ENDPOINTS] };

function analysisConfigPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "analysis-config.json");
}

export function getAnalysisConfig(userId: string): AnalysisConfig {
  const path = analysisConfigPath(userId);
  if (!existsSync(path)) return DEFAULT_CONFIG;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as AnalysisConfig | null;
  return parsed ?? DEFAULT_CONFIG;
}

export function setAnalysisConfig(userId: string, config: AnalysisConfig): void {
  const path = analysisConfigPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(config), "utf8");
}

/** Resets back to the real default ("all") -- the settings UI's "Send All" button. */
export function resetAnalysisConfigToAll(userId: string): AnalysisConfig {
  setAnalysisConfig(userId, DEFAULT_CONFIG);
  return DEFAULT_CONFIG;
}

/** Sets a custom timeframe subset, switching mode to "custom". Rejects anything not a real
 *  supported timeframe rather than silently accepting a typo. */
export function setCustomTimeframes(userId: string, timeframes: string[]): AnalysisConfig {
  const valid = timeframes.map((tf) => tf.trim().toUpperCase()).filter((tf) => (ALL_ANALYSIS_TIMEFRAMES as readonly string[]).includes(tf));
  const current = getAnalysisConfig(userId);
  const next: AnalysisConfig = { mode: "custom", timeframes: valid.length > 0 ? valid : current.timeframes, endpoints: current.endpoints };
  setAnalysisConfig(userId, next);
  return next;
}

/** Sets a custom endpoint subset, switching mode to "custom". Same reject-invalid-entries
 *  behavior as setCustomTimeframes. */
export function setCustomEndpoints(userId: string, endpoints: string[]): AnalysisConfig {
  const valid = endpoints.map((e) => e.trim().toLowerCase()).filter((e) => (ALL_ANALYSIS_ENDPOINTS as readonly string[]).includes(e));
  const current = getAnalysisConfig(userId);
  const next: AnalysisConfig = { mode: "custom", timeframes: current.timeframes, endpoints: valid.length > 0 ? valid : current.endpoints };
  setAnalysisConfig(userId, next);
  return next;
}

/** Real gap fixed (user, live: "didn't I tell you to make the endpoints and timeframes in the
 *  analysis scope UI" -- a typed-reply capture is not a real UI, every other setting in this app
 *  is a tappable button). Toggles a single timeframe in the custom set -- on if it was off, off
 *  if it was on -- switching mode to "custom" the first time. When toggling FROM "all" mode, the
 *  starting set is the full real list (not empty), so switching one off narrows by exactly one,
 *  never wipes the rest. Never lets the set go empty -- a toggle that would remove the last
 *  remaining entry is refused, since an empty scope is a real, silent "sends nothing" bug. */
export function toggleTimeframe(userId: string, timeframe: string): AnalysisConfig {
  const tf = timeframe.trim().toUpperCase();
  if (!(ALL_ANALYSIS_TIMEFRAMES as readonly string[]).includes(tf)) return getAnalysisConfig(userId);
  const current = getAnalysisConfig(userId);
  const base = current.mode === "all" ? [...ALL_ANALYSIS_TIMEFRAMES] : current.timeframes;
  const has = base.includes(tf);
  if (has && base.length <= 1) return { ...current, mode: "custom", timeframes: base };
  const next: AnalysisConfig = { mode: "custom", timeframes: has ? base.filter((t) => t !== tf) : [...base, tf], endpoints: current.mode === "all" ? [...ALL_ANALYSIS_ENDPOINTS] : current.endpoints };
  setAnalysisConfig(userId, next);
  return next;
}

/** Same real toggle behavior as toggleTimeframe, for a single endpoint. */
export function toggleEndpoint(userId: string, endpoint: string): AnalysisConfig {
  const ep = endpoint.trim().toLowerCase();
  if (!(ALL_ANALYSIS_ENDPOINTS as readonly string[]).includes(ep)) return getAnalysisConfig(userId);
  const current = getAnalysisConfig(userId);
  const base = current.mode === "all" ? [...ALL_ANALYSIS_ENDPOINTS] : current.endpoints;
  const has = base.includes(ep);
  if (has && base.length <= 1) return { ...current, mode: "custom", endpoints: base };
  const next: AnalysisConfig = { mode: "custom", endpoints: has ? base.filter((e) => e !== ep) : [...base, ep], timeframes: current.mode === "all" ? [...ALL_ANALYSIS_TIMEFRAMES] : current.timeframes };
  setAnalysisConfig(userId, next);
  return next;
}

/** Filters a merged "all"-endpoint suite object down to only the configured endpoint keys --
 *  a no-op (returns the object unchanged) when mode is "all", so the default behavior never
 *  drops anything the EA genuinely returned. */
export function filterSuiteToConfig(suite: Record<string, unknown>, config: AnalysisConfig): Record<string, unknown> {
  if (config.mode === "all") return suite;
  const allowed = new Set(config.endpoints);
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(suite)) {
    if (allowed.has(key)) filtered[key] = value;
  }
  return filtered;
}
