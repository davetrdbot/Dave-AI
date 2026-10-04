import { getLastKnownState, getLastKnownAccountSnapshot, isEaOutdated } from "./ea-webhook.js";
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
  /**
   * Optional override for the real EA analysis round-trip's timeout, per call context. Undefined
   * uses requestAnalysis's own real default (300s, sized for the EA's 2-minute push interval).
   */
  timeoutMs?: number;
  /**
   * Real gap fixed (user, live: doubted `get_all_analysis` genuinely fetches the full suite
   * rather than something silently partial/stubbed). Optional DI callback -- dave-ea-bridge has
   * no dependency on dave-agent-loop (the dependency runs the other way: agent-loop depends on
   * ea-bridge), so this package cannot import agent-loop's file-backed analysis-debug-store
   * directly without creating a real circular package dependency. Same pattern already used by
   * JOURNAL_TOOLS's `onTradeLogged` in full-registry.ts -- the caller (dave-agent-loop, wiring up
   * this context at registration time) supplies the real recorder; this package just invokes it
   * with the real values from what was actually fetched, right at the real fetch site.
   */
  onAnalysisDebug?: (entry: AnalysisDebugFetch) => void;
}

/** Mirrors AnalysisDebugEntry (minus `rawSuite`'s specific shape, which is just `unknown` here
 *  too) in packages/dave-agent-loop/src/analysis-debug-store.ts, without importing it. */
export interface AnalysisDebugFetch {
  symbol: string;
  timeframesRequested: string[];
  timeframesReceived: string[];
  endpointKeysPerTimeframe: Record<string, string[]>;
  totalPayloadBytes: number;
  fetchedAt: number;
  rawSuite: unknown;
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
      return {
        balance: snapshot.balance,
        equity: snapshot.equity,
        margin: snapshot.margin,
        freeMargin: snapshot.freeMargin,
        marginLevel: snapshot.marginLevel,
        leverage: snapshot.leverage,
        currency: snapshot.currency,
        floatingProfit: snapshot.profit,
        eaVersion: snapshot.eaVersion ?? "older than 3.0",
        eaUpdateAvailable: isEaOutdated(snapshot.eaVersion),
        updatedAt: snapshot.updatedAt,
      };
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
    execute: async (args, ctx) => requestAnalysis(ctx.userId, endpoint, args.symbol as string, (args.timeframe as string) ?? "M15", ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : undefined),
  };
}

export const EA_ANALYSIS_TOOLS: EaToolDefinition[] = [
  // EA 4.0 groups: each one holds raw facts (rules printed inside), worked out on CLOSED candles from one
  // shared memory per symbol+timeframe -- no duplicates across groups.
  analysisTool("get_price", "price", "live price: bid/ask, spread now vs normal, quote age, market open, frozen-feed check, today/yesterday (pdh/pdl), week (pwh/pwl), month and 52-week levels, ADR14 and % used today, spread vs ATR, broker stop/freeze levels"),
  {
    name: "get_candles",
    description:
      "Candles from the MT5 EA, newest first: the still-forming candle (closed:false, seconds_left) plus closed ones, each with UTC time, OHLC, tick volume, " +
      "body/wicks, size vs ATR, close position in the range, gap, and a pattern name on closed candles (doji, pin bar, engulfing, inside/outside bar, morning/evening star); " +
      "plus the same-direction run and an APA Type 1 engulfing flag. count = how many (default 21, up to 300).",
    parameters: {
      type: "object",
      properties: { symbol: { type: "string" }, timeframe: { type: "string" }, count: { type: "number", description: "how many candles, 1-300 (default 21)" } },
      required: ["symbol"],
    },
    execute: async (args, ctx) =>
      requestAnalysis(ctx.userId, "candles", args.symbol as string, (args.timeframe as string) ?? "M15", {
        ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
        params: { count: Math.max(1, Math.min(300, Math.round(Number(args.count) || 21))) },
      }),
  },
  analysisTool("get_market_structure", "market_structure", "market structure of ONE timeframe from its own closed candles: wick swings (HH/HL/LH/LL), trend, BOS/CHoCH with body close and displacement, CISD, swing failures, dealing range + premium/discount + OTE, inducement, trendline, legs and pullback depth, the higher timeframe's trend, and APA: validation, shift point, shifted/transition, shift type, reclaim point, pure vs different trend"),
  analysisTool("get_liquidity", "liquidity", "liquidity: untaken buy-side pools above / sell-side below (touches, distance), equal highs/lows, untouched old highs/lows, sweeps and the move after, side swept today, pdh/pdl taken, draw on liquidity, and APA liquidity engineering (level, thrust candle, FMD for the stop, CHoCH, complete or what is missing)"),
  analysisTool("get_zones", "zones", "zones sorted by distance: order blocks, breakers, FVG/IFVG/BPR, opening gaps, with top/bottom, width, age, touches, fresh, consumed % (50% = consumed), invalidation and SL size; APA areas of liquidity (AOL between validation and invalidation, Types 1-4 per the book), price inside AOL, lower-timeframe refinement zones inside the AOL"),
  analysisTool("get_trend", "trend", "trend facts: EMA 20/50/200, SMA200, SMMA 6/20/100 (value, price above/below, slope), SMA50/200 cross, distance from EMA20 in ATR, Wilder ADX/DI, Supertrend(10,3), Ichimoku (price vs cloud, colour, TK cross), regression slope, efficiency ratio, higher-timeframe EMA200, regime"),
  analysisTool("get_momentum", "momentum", "momentum on closed candles: RSI 14 (last 5, bars since >70/<30, higher-timeframe RSI), MACD 12/26/9 (+ last cross), stochastic 14/3/3, ROC 10, z-score, latest divergence between confirmed swings"),
  analysisTool("get_volatility", "volatility", "volatility: ATR (pips, vs median, percentile), Bollinger, Keltner, squeeze (length, released), Donchian 20, historical volatility, expanding/contracting, expected move to session end"),
  analysisTool("get_volume", "volume", "tick-volume facts (MT5 has no buyer/seller side on forex/synthetics -- estimates are labelled): volume vs average and vs the same time of day, spikes/climax, estimated tick-direction pressure, tick speed, leg participation, OBV, tick VWAP with bands, tick profile POC/value area"),
  analysisTool("get_levels", "levels", "levels: daily/weekly/monthly pivots, Camarilla, round numbers, Fibonacci on the last external leg, one merged ladder of the nearest levels above/below with what meets there, APA flip levels (H4+, >2 touches, flip confirmed, single candle structure) and APA flip entry type 2 (flip zone, multiple candle structure, breakout, return, higher-timeframe wick overlap)"),
  analysisTool("get_session", "session", "sessions (UTC, London/New York local time with DST): open now, minutes to opens, killzones/silver bullet, Asian range, London/NY opening ranges, Asia/London/NY highs and lows today and yesterday, opens (midnight/London/NY), London swept Asia, Judas swing, CBDR, bank holiday, rollover, month-end/Friday/Sunday flags. 24/7 symbols: no sessions"),
  analysisTool("get_news", "news", "economic calendar for both currencies of the pair: next 24 h events, minutes to next high-impact, blackout now (rule printed), last high-impact release with actual/forecast/previous, surprise and the 15-minute price reaction. Synthetics: not news-driven"),
  analysisTool("get_intermarket", "intermarket", "currency strength ranking (1/5/20 hours, 28 crosses), correlation with EURUSD/GBPUSD/USDJPY/XAUUSD (50, 20 vs 100 + break flag), DXY proxy change, gold and USDJPY 5-day change"),
  analysisTool("get_chart_patterns", "chart_patterns", "chart patterns from external swings only (max 2): double top/bottom, head and shoulders, triangles/wedges, completed harmonics (H1+), with key prices, height, status and measured target"),
  analysisTool("get_summary", "summary", "summary across timeframes: structure bias D1/H4/H1/M15 (weighted votes shown), confluence factors with votes, ATR stop sizes vs the broker minimum, APA monthly and weekly cycles, timeframes agreeing, FTA ahead, entry-module parts"),
  // Older names used by saved strategy skills -- they answer from the group that holds that data now.
  analysisTool("get_structure", "market_structure", "older name of get_market_structure (same answer)"),
  analysisTool("get_swing", "market_structure", "older name: swings are in get_market_structure (same answer)"),
  analysisTool("get_patterns", "candles", "older name: candle patterns are in get_candles (same answer)"),
  // Real gap fixed (user, live: wants get_all_analysis to also show whether a position/pending
  // order already exists on this symbol, so the model can't "forget" it just placed something).
  // A dedicated definition, not the shared analysisTool() factory, since this one merges in real
  // state on top of the pure market analysis every other endpoint returns.
  {
    name: "get_all_analysis",
    description:
      "All 15 analysis groups above in ONE response (price, candles, market_structure, liquidity, zones, trend, momentum, volatility, volume, levels, session, news, intermarket, chart_patterns, summary) for the given symbol/timeframe, with a freshness label. " +
      "Also reports whether you already have a real open position or pending order on this symbol, so you never propose a duplicate trade on something you've already placed. " +
      "ALSO includes full account-wide awareness on every call: every open position and pending order across ALL symbols (not just this one), and real account margin data " +
      "(balance/equity/margin/freeMargin/leverage plus a computed marginLevel), so you're never tunnel-visioned on just the current symbol.",
    parameters: { type: "object", properties: { symbol: { type: "string" }, timeframe: { type: "string" } }, required: ["symbol"] },
    execute: async (args, ctx) => {
      const symbol = args.symbol as string;
      const timeframe = (args.timeframe as string) ?? "M15";
      const result = await requestAnalysis(ctx.userId, "all", symbol, timeframe, ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : undefined);
      const state = getLastKnownState(ctx.userId);
      const upper = symbol.toUpperCase();
      const resultObj = (typeof result === "object" && result !== null ? result : {}) as Record<string, unknown>;

      // Real gap fixed (user: get_all_analysis must give full account awareness, not just
      // tunnel-vision on the one symbol being analyzed) -- every open position/pending order
      // account-wide, plus real account margin data. getLastKnownState/getLastKnownAccountSnapshot
      // are both already-real, already-persisted EA report data (see ea-webhook.ts) -- nothing
      // here is fabricated: an account with no snapshot yet genuinely reports undefined/null, never
      // an invented number.
      const snapshot = getLastKnownAccountSnapshot(ctx.userId);
      const margin = snapshot?.margin;
      const equity = snapshot?.equity;
      const marginLevel = margin !== undefined && margin > 0 && equity !== undefined ? (equity / margin) * 100 : null;
      const accountMargin = {
        balance: snapshot?.balance,
        equity,
        margin,
        freeMargin: snapshot?.freeMargin,
        leverage: snapshot?.leverage,
        marginLevel,
        updatedAt: snapshot?.updatedAt,
      };

      const finalResult = {
        ...resultObj,
        openPositionsForSymbol: state.positions.filter((p) => p.symbol.toUpperCase() === upper),
        pendingOrdersForSymbol: state.pendingOrders.filter((p) => p.symbol.toUpperCase() === upper),
        allOpenPositions: state.positions,
        allPendingOrders: state.pendingOrders,
        accountMargin,
      };

      // Real, honest record of what THIS call actually got back -- requestAnalysis already
      // threw above if the EA round-trip genuinely failed, so reaching here means this one
      // timeframe's fetch genuinely succeeded. endpointKeysPerTimeframe reflects the real
      // top-level keys the EA's "all" endpoint actually returned, not an assumed/expected list.
      const endpointKeysPerTimeframe: Record<string, string[]> = { [timeframe]: Object.keys(resultObj) };
      const totalPayloadBytes = Buffer.byteLength(JSON.stringify(finalResult), "utf8");
      const debugEntry: AnalysisDebugFetch = {
        symbol,
        timeframesRequested: [timeframe],
        timeframesReceived: [timeframe],
        endpointKeysPerTimeframe,
        totalPayloadBytes,
        fetchedAt: Date.now(),
        rawSuite: finalResult,
      };
      console.log("[analysis-debug] " + JSON.stringify({ symbol, timeframesRequested: [timeframe], timeframesReceived: [timeframe], endpointKeysPerTimeframe, totalPayloadBytes, fetchedAt: debugEntry.fetchedAt }));
      ctx.onAnalysisDebug?.(debugEntry);

      return finalResult;
    },
  },
  analysisTool("ping_ea", "ping", "a trivial health check confirming the connected EA is alive and responsive -- no market data"),
  {
    name: "get_position_size",
    description:
      "EXACT lot size for a trade, calculated by MT5 itself (OrderCalcProfit): from the side, the entry (default: the current price), the stop loss, " +
      "and the risk (risk_pct of the balance, default 1%, or risk_money). Works for any pair, gold or synthetic index. " +
      "Returns lots (rounded DOWN to the broker's lot step), the money actually at risk, the loss per 1 lot, margin needed, and whether it's below the minimum lot.",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        side: { type: "string", enum: ["buy", "sell"] },
        sl: { type: "number", description: "stop loss price" },
        entry: { type: "number", description: "entry price (omit for the current price)" },
        risk_pct: { type: "number", description: "% of balance to risk (default 1)" },
        risk_money: { type: "number", description: "money to risk, in the account currency (instead of risk_pct)" },
      },
      required: ["symbol", "side", "sl"],
    },
    execute: async (args, ctx) => {
      const params: Record<string, string | number> = { side: String(args.side ?? "buy"), sl: Number(args.sl) };
      if (typeof args.entry === "number" && args.entry > 0) params.entry = args.entry;
      if (typeof args.risk_pct === "number" && args.risk_pct > 0) params.risk_pct = args.risk_pct;
      if (typeof args.risk_money === "number" && args.risk_money > 0) params.risk_money = args.risk_money;
      return requestAnalysis(ctx.userId, "position_size", args.symbol as string, "M15", { ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}), params });
    },
  },
  {
    name: "get_symbol_info",
    description:
      "The contract for a symbol, straight from the broker via MT5: digits, pip, contract size, tick and pip value per lot, min/max/step lots, " +
      "margin needed per lot, minimum stop distance (stops level) and freeze level, spread, swaps, trading hours today (UTC) and whether the market is open right now.",
    parameters: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
    execute: async (args, ctx) =>
      requestAnalysis(ctx.userId, "symbol_info", args.symbol as string, "M15", ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : undefined),
  },
  {
    name: "get_open_trades",
    description:
      "Every open trade and pending order straight from MT5 with management facts: profit in money and in R (from the opening stop), best/worst R reached, distance to SL/TP, " +
      "whether breakeven is allowed by the broker's freeze/stop levels, candles open (H1), and the H1 area-of-liquidity invalidation with whether it was closed through since entry.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => requestAnalysis(ctx.userId, "open_trades", "", "H1", ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : undefined),
  },
  {
    name: "get_deal_history",
    description:
      "Real closed trades straight from MT5's own history for the last N days (default 7, up to 90), with every fee: profit, swap, commission and net per trade, " +
      "the close reason (tp / sl / stopout / dave / manual), and a summary (win rate, net, profit factor, total commissions and swaps, deposits and withdrawals). " +
      "Optional symbol to filter.",
    parameters: {
      type: "object",
      properties: { days: { type: "number", description: "1-90 (default 7)" }, symbol: { type: "string", description: "only this symbol (optional)" } },
    },
    execute: async (args, ctx) =>
      requestAnalysis(ctx.userId, "history", typeof args.symbol === "string" ? args.symbol : "", "M15", {
        ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
        params: { days: Math.max(1, Math.min(90, Math.round(Number(args.days) || 7))) },
      }),
  },
];
