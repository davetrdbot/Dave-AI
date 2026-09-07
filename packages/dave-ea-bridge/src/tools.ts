import { getLastKnownState, getLastKnownAccountSnapshot } from "./ea-webhook.js";
import { requestAnalysis } from "./analysis-request.js";

/**
 * Part 1 item 10 (bot-side half): "the agent should NOT have to wait for
 * the periodic push if it needs current state right now." Honest about
 * what's actually possible -- MT5's WebRequest is one-directional, so
 * there is no way to force the EA to push early. What these genuinely
 * do is read the most recently RECEIVED report/snapshot back instantly,
 * bypassing the wait for dave-ea-bridge's own next scheduled read --
 * not a live round-trip to MT5.
 */
export interface EaToolContext {
  userId: string;
}

export interface EaToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: EaToolContext) => Promise<unknown>;
}

export const EA_STATE_TOOLS: EaToolDefinition[] = [
  {
    name: "get_live_state",
    description:
      "Get the current tick/positions/pending-orders state right now, without waiting for the periodic push interval. " +
      "Reflects the EA's most recently received report (real, but eventually-consistent -- not a live MT5 query, since " +
      "WebRequest is one-directional and Dave cannot force the EA to report early).",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => getLastKnownState(ctx.userId),
  },
  {
    name: "get_account_balance",
    description: "Get the account balance/equity/margin right now, standalone -- doesn't require pulling full state just to see the balance.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => {
      const snapshot = getLastKnownAccountSnapshot(ctx.userId);
      if (!snapshot) return { balance: undefined, note: "no EA report received yet for this user" };
      return { balance: snapshot.balance, equity: snapshot.equity, margin: snapshot.margin, freeMargin: snapshot.freeMargin, updatedAt: snapshot.updatedAt };
    },
  },
];

/**
 * Item 5 (DAVEMA retirement): real, on-demand market analysis computed LIVE by the connected
 * MT5 EA itself -- no external API call. Each of these is a SEPARATE, on-demand tool (not
 * automatically included in every message) so calling Dave never pays for analysis it doesn't
 * ask for; the EA's existing heartbeat/account-push cadence is completely unchanged. All 46 real
 * DAVEMA endpoints are ported here (item 8 audit follow-up, user: "add all the endpoints and all
 * the features included in the endpoints") -- see ea/DaveEA.mq5's A_* functions and RunAnalysis's
 * dispatch for the real computation, ported directly from the user's own reference DAVEMA_EA_1.mq5.
 */
function analysisTool(toolName: string, endpoint: string, summary: string): EaToolDefinition {
  return {
    name: toolName,
    description: `Real, on-demand ${summary} computed LIVE by the connected MT5 EA for ANY symbol in its Market Watch, not just the chart it's attached to. Replaces the retired DAVEMA /${endpoint} endpoint.`,
    parameters: { type: "object", properties: { symbol: { type: "string" }, timeframe: { type: "string" } }, required: ["symbol"] },
    execute: async (args, ctx) => requestAnalysis(ctx.userId, endpoint, args.symbol as string, (args.timeframe as string) ?? "M15"),
  };
}

export const EA_ANALYSIS_TOOLS: EaToolDefinition[] = [
  analysisTool("get_trend", "trend", "trend analysis (moving averages, EMA alignment, golden/death cross, bias score)"),
  analysisTool("get_momentum", "momentum", "momentum analysis (RSI/MACD/Stochastic/CCI/Williams %R, overall bull/bear signal)"),
  analysisTool("get_volatility", "volatility", "volatility analysis (ATR, Bollinger Bands, Keltner Channel, expansion/contraction, volatility regime)"),
  analysisTool("get_price", "price", "price snapshot (bid/ask/spread, day/week/month/52w high-low, swap, lot size limits)"),
  analysisTool("get_structure", "structure", "market structure (HH/HL/LH/LL trend, BOS, CHoCH, MSS, CISD, dealing range, premium/discount, OTE zone)"),
  analysisTool("get_zones", "zones", "supply/demand zones (fresh/tested, strength score, mitigation %, nearest/strongest zone)"),
  analysisTool("get_liquidity", "liquidity", "liquidity levels (BSL/SSL, equal highs/lows, sweeps, liquidity voids)"),
  analysisTool("get_volume", "volume", "volume analysis (current vs average, bull/bear volume delta, spikes/climax)"),
  analysisTool("get_ichimoku", "ichimoku", "Ichimoku Cloud (tenkan/kijun/senkou A+B/chikou, cloud position, TK cross, signal score)"),
  analysisTool("get_fibonacci", "fibonacci", "Fibonacci retracement/extension levels, nearest level, OTE zone, golden-ratio bounce"),
  analysisTool("get_candles", "candles", "the last 10 real candles with body/wick ratios, size vs ATR, gap and imbalance detection"),
  analysisTool("get_patterns", "patterns", "candlestick pattern recognition (single/double/triple patterns, strongest pattern, bias, reliability)"),
  analysisTool("get_ict", "ict", "ICT concepts (FVG/iFVG, order blocks, breaker blocks, killzones, silver bullet, Judas swing, AMD phase, OTE zone)"),
  analysisTool("get_wyckoff", "wyckoff", "Wyckoff phase analysis (accumulation/distribution/markup, spring/UTAD events, effort-vs-result)"),
  analysisTool("get_divergence", "divergence", "RSI/MACD/Stochastic divergence detection (regular and hidden, bull/bear, strongest/confirmed)"),
  analysisTool("get_session", "session", "trading session status (Tokyo/London/NY/Sydney, overlaps, time to next session, Asian range)"),
  analysisTool("get_pivots", "pivots", "pivot points (classic/Fibonacci/Camarilla/weekly/monthly, nearest pivot, price vs pivot)"),
  analysisTool("get_levels", "levels", "round-number/psychological levels (big/half figures, nearby round levels, 52-week high/low distance)"),
  analysisTool("get_orderflow", "orderflow", "order-flow analysis (buy/sell volume delta, absorption, climax, stop runs, momentum ignition)"),
  analysisTool("get_confluence", "confluence", "multi-signal confluence score (MA trend/RSI/MACD/ADX/price-action agreement, direction, strength)"),
  analysisTool("get_risk_metrics", "risk_metrics", "risk sizing metrics (ATR-based SL/TP levels, R:R ratios, pip value, recommended lot size per % risk)"),
  analysisTool("get_synthetic", "synthetic", "synthetic-index analysis (Boom/Crash/Volatility spike detection, due/overdue, spike probability)"),
  analysisTool("get_elliott", "elliott", "Elliott Wave analysis (current wave count, impulse/correction, wave target/invalidation)"),
  analysisTool("get_correlation", "correlation", "cross-market correlation (vs EURUSD/DXY proxy, risk-on/off, safe-haven status)"),
  analysisTool("get_strength", "strength", "currency strength for this pair's base/quote currencies (differential, bias, strongest/weakest)"),
  analysisTool("get_heatmap", "heatmap", "currency strength heatmap across all 8 majors"),
  analysisTool("get_fractal", "fractal", "Williams fractal up/down points"),
  analysisTool("get_harmonic", "harmonic", "harmonic pattern detection (Gartley/Bat/Butterfly/Crab, XABCD ratios, PRZ, confidence)"),
  analysisTool("get_mean_reversion", "mean_reversion", "mean-reversion analysis (z-score vs 20-period mean, overextension, revert-long/short signal)"),
  analysisTool("get_tape", "tape", "real tick-tape analysis (up/down tick ratio, tape bias, fast-tape detection)"),
  analysisTool("get_tape_flow", "tape_flow", "cumulative volume delta and aggressive buyer/seller flow"),
  analysisTool("get_seasonality", "seasonality", "seasonality (most volatile hour of day, hourly average range, month/day-of-week context)"),
  analysisTool("get_spread_analysis", "spread_analysis", "spread cost analysis (spread vs ATR, cost rating, tradeable flag, execution mode)"),
  analysisTool("get_gann", "gann", "Gann level analysis (fan ratios, nearest Gann level, Square of 9 projection)"),
  analysisTool("get_market_profile", "market_profile", "market/volume profile (POC, value area high/low, price vs value area, profile shape)"),
  analysisTool("get_macro", "macro", "macro context (daily/weekly change, DXY/gold/USDJPY proxies, risk-on/off regime)"),
  analysisTool("get_news", "news", "upcoming real economic-calendar events for this pair's currencies (high-impact count, news blackout window)"),
  analysisTool("get_sentiment", "sentiment", "composite sentiment score (RSI + MACD + bull-bar % blended into a fear/greed-style label)"),
  analysisTool("get_regime", "regime", "market regime classification (trending/ranging/transitional, volatility regime, suggested trading style)"),
  analysisTool("get_backtest", "backtest", "a quick real MA20/50-cross backtest over the loaded history (win rate, net pips, edge)"),
  analysisTool("get_swing", "swing", "real swing highs/lows with bar index and timestamp, last leg direction"),
  analysisTool("get_order_blocks", "order_blocks", "bullish/bearish order blocks (high/low, center, mitigated status, distance)"),
  analysisTool("get_inducement", "inducement", "inducement/IDM levels (taken status, next liquidity target, valid-setup flag)"),
  analysisTool("get_premium_discount", "premium_discount", "premium/discount zone position within the dealing range, OTE zone, bias"),
  analysisTool("get_all_analysis", "all", "every one of the 44 real analysis endpoints above, in ONE response, for the given symbol/timeframe -- use when you need a full market read, not a single indicator"),
  analysisTool("ping_ea", "ping", "a trivial health check confirming the connected EA is alive and responsive -- no market data"),
];
