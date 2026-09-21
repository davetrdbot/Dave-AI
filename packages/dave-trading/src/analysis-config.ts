import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Real feature (user, live: "add a feature in the settings that the user can configure the get
 * all analysis so they will select among endpoints to sent to the bot and the timeframe, and a
 * default button to send all"). Defaults to sending everything (matches today's real behavior,
 * confirmed correct against the user's own original spec) -- a user only ever narrows this
 * deliberately, never accidentally.
 *
 * D1's real history here, because it has moved twice and the reason matters more than the value:
 *
 * It was added once (the HTF strategy skill needs it), then REVERTED on the trader's own blunt
 * objection -- "I'm not a day trader, wtf does it have to do with day" -- back to their earlier
 * explicit spec (commit 4b9efe6: M1, M3, M5, M15, H1, H4). That revert was right about the
 * trader's intent and wrong about the consequence, and nobody checked the consequence: the
 * trader's installed HTF Top-Down Pullback strategy skill was left ACTIVE, and that skill opens
 * with "Read in this order, every time, before any entry: D1 -> H4 -> H1 -> M15 -> M5", while
 * autonomous-tick.ts tells the model to follow the active skill exactly and NOT to supplement it
 * with other timeframes. So step one of the only strategy in force required data the system had
 * just stopped fetching. The autonomous loop deadlocked: confirmed live in Railway logs, 41
 * consecutive cycles, every one SKIP, eleven of them with the identical sentence "no valid setup
 * under the top-down flow" -- not setups being evaluated and rejected, but a flow that could
 * never reach step two. Zero trades, no error anywhere.
 *
 * Restored deliberately by the trader with that deadlock in front of them. Note what D1 is FOR
 * here: it is the strategy's directional BIAS anchor, read once at the top of the funnel. Entries
 * are still found and timed on M15/M5 exactly as before -- adding it does not make this a daily
 * strategy, which was the trader's actual objection. Ordered high-to-low to match the top-down
 * language the strategy itself uses.
 *
 * The lesson worth keeping: removing a timeframe is never just a data change while a strategy
 * skill still requires it. isAnalysisScopeSufficientFor() below exists so this specific failure
 * -- a silent, permanent, error-free stand-down -- cannot recur unnoticed.
 */
export const ALL_ANALYSIS_TIMEFRAMES = ["D1", "H4", "H1", "M15", "M5", "M3", "M1"] as const;

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

/** Every timeframe token a strategy skill might name, longest-first so "M15" is never matched as
 *  "M1" followed by a stray "5". W1/MN1 are included even though the EA suite never fetches them,
 *  precisely so a skill demanding one is reported as unsatisfiable rather than silently ignored. */
const KNOWN_TIMEFRAME_TOKENS = ["MN1", "W1", "D1", "H4", "H1", "M30", "M15", "M5", "M3", "M1"] as const;

export interface AnalysisScopeCheck {
  sufficient: boolean;
  /** Timeframes the skill names that the current scope genuinely will not fetch. */
  missing: string[];
  /** What the scope actually supplies right now, for the caller's own message. */
  active: string[];
}

/**
 * Real failure this exists to prevent, confirmed live rather than imagined (see
 * ALL_ANALYSIS_TIMEFRAMES above for the full account): the trader's active strategy skill opened
 * with "Read in this order, every time, before any entry: D1 -> H4 -> H1 -> M15 -> M5" while the
 * analysis scope had been narrowed to exclude D1. The autonomous loop then stood down on every
 * single cycle -- 41 in a row -- because step one of the only strategy in force could never
 * complete. There was no error, no exception, and nothing in any log said "this cannot work": it
 * read exactly like a cautious bot finding no setups, which is why it ran for hours unnoticed.
 *
 * Deliberately a HEURISTIC and deliberately non-blocking. It scans the skill's own text for
 * timeframe tokens and reports the ones the current scope won't supply; a skill that merely
 * mentions a timeframe in passing will produce a false positive. That trade is on purpose -- a
 * spurious warning costs a glance, whereas the failure it catches is invisible and total. Callers
 * surface it; nothing here refuses to trade on its own.
 */
export function isAnalysisScopeSufficientFor(userId: string, skillContent: string): AnalysisScopeCheck {
  const config = getAnalysisConfig(userId);
  const active = config.mode === "custom" && config.timeframes.length > 0 ? config.timeframes : [...ALL_ANALYSIS_TIMEFRAMES];
  const activeSet = new Set(active.map((t) => t.toUpperCase()));

  const upper = skillContent.toUpperCase();
  const missing: string[] = [];
  for (const token of KNOWN_TIMEFRAME_TOKENS) {
    if (activeSet.has(token) || missing.includes(token)) continue;
    // Word-boundary match so H1 inside "H15" or a bare number never counts.
    const at = new RegExp(`(^|[^A-Z0-9])${token}([^A-Z0-9]|$)`).exec(upper);
    if (!at) continue;
    if (isOfferedAsAlternative(upper, at.index, token, activeSet)) continue;
    missing.push(token);
  }
  return { sufficient: missing.length === 0, missing, active };
}

/**
 * Distinguishes a REQUIRED rung from one of several acceptable choices, which is the difference
 * between a strategy that cannot run and one that is perfectly fine.
 *
 * Found by running this against the trader's own installed skill rather than a fixture: it flagged
 * M30, from "A structure shift is a CHoCH on M5, M15, or M30". M5 and M15 are both fetched, so the
 * rule is satisfiable and warning about it would be wrong -- and a warning that fires every cycle
 * on a healthy strategy is worse than no warning, because it trains everyone to ignore it.
 *
 * The signal is the connector. "D1 -> H4 -> H1 -> M15 -> M5" is a sequence: every rung is needed,
 * so a missing one is fatal even though the others are present. "M5, M15, or M30" is an
 * alternation: any one will do, so a missing option costs nothing. Looking only at nearby
 * timeframes cannot tell these apart -- both sit beside in-scope neighbours -- so this keys on an
 * explicit "or" in the immediate vicinity instead.
 */
function isOfferedAsAlternative(upper: string, index: number, token: string, activeSet: Set<string>): boolean {
  const window = upper.slice(Math.max(0, index - 60), index + token.length + 60);
  if (!/(^|[^A-Z])OR([^A-Z]|$)/.test(window)) return false;
  // An "or" only rescues it when a timeframe we genuinely DO fetch is among the options.
  return KNOWN_TIMEFRAME_TOKENS.some((other) => other !== token && activeSet.has(other) && new RegExp(`(^|[^A-Z0-9])${other}([^A-Z0-9]|$)`).test(window));
}
