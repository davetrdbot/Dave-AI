---
name: ea-analysis
description: The 15 market-analysis groups your connected MT5 EA (version 4.0) computes on demand -- what each one holds and when to reach for it. Raw facts with their rules printed inside, closed candles only, for ANY symbol in Market Watch.
use_when: You're analyzing a symbol before deciding whether a setup is real, explaining your reasoning to the user, or need a specific piece of structure/liquidity/zone/indicator data.
---

# Your market analysis tools (EA 4.0: 15 groups, no duplicates)

Every group is computed by your own connected MT5 EA from ONE shared memory per
symbol+timeframe, worked out on CLOSED candles only when a new candle closes --
so the groups never contradict each other and answer in milliseconds. Each answer
starts with `_meta`: when the last candle closed, whether the forming candle is
still open and when it closes, whether the data came from memory (`from_cache`),
`bars_behind`, `market_open`, `quote_age_sec`. If `_meta` says the data is not live,
say so and don't enter on it alone.

The EA gives FACTS, not opinions: each answer carries the rule it used (`rules`).
You make the decision.

Every call takes `symbol` (required) and `timeframe` (optional, default M15).

## The groups

- **get_price** -- bid/ask, spread now vs normal, quote age, market open, frozen
  feed, today/yesterday (pdh/pdl), week (pwh/pwl), month, 52-week (forex only),
  ADR14 and % used today, spread vs ATR, broker stop and freeze levels.
- **get_candles** -- candles newest first (the forming one marked), OHLC, tick
  volume, body/wicks, size vs ATR, close position, gap, pattern name on closed
  candles, same-direction run, APA Type 1 flag. `count` up to 300.
- **get_market_structure** -- wick swings (HH/HL/LH/LL), trend, BOS/CHoCH with a
  body close and displacement flag, CISD, swing failures, dealing range,
  premium/discount, OTE, inducement, trendline, legs and pullback depth, the
  higher timeframe's trend. APA: validation, shift point (a CLOSE beyond it =
  shift), shifted / transition, shift type, reclaim point, pure vs different trend.
- **get_liquidity** -- untaken buy-side pools above and sell-side below, equal
  highs/lows, untouched old highs/lows, sweeps and the move after, side swept
  today, pdh/pdl taken, draw on liquidity. APA liquidity engineering: the level,
  the thrust candle, the FMD (your stop goes beyond it), the CHoCH, complete or
  what is missing.
- **get_zones** -- order blocks, breakers, FVG/IFVG/BPR, opening gaps, each with
  top/bottom, width, age, touches, fresh, consumed % (50% = consumed, APA),
  invalidation and SL size. APA areas of liquidity: the AOL between the last
  break's validation and invalidation, Type 1 (same colour + sweep + engulf),
  Type 2 (opposite colour + sweep + close beyond), Type 3 (opposite colour, no
  sweep, no/minor wick, close beyond), Type 4 (W1/MN1 wick overlap, needs lower
  timeframe structure), refinement zones inside the AOL.
- **get_trend** -- EMA 20/50/200, SMA200, SMMA 6/20/100, SMA50/200 cross,
  distance from EMA20 in ATR, Wilder ADX/DI, Supertrend(10,3), Ichimoku (price vs
  cloud, colour, TK cross), regression slope, efficiency ratio, higher-timeframe
  EMA200, regime.
- **get_momentum** -- RSI 14 (last 5 closed, bars since >70/<30, higher-timeframe
  RSI), MACD 12/26/9 with last cross, stochastic 14/3/3, ROC, z-score, latest
  divergence between two confirmed swings.
- **get_volatility** -- ATR (pips, vs median, percentile), Bollinger, Keltner,
  squeeze (length, released), Donchian 20, historical volatility,
  expanding/contracting, expected move to session end.
- **get_volume** -- tick volume vs average and vs the same time of day, spikes,
  ESTIMATED tick-direction pressure (MT5 has no buyer/seller side on forex and
  synthetics), tick speed, leg participation, OBV, tick VWAP, tick profile.
- **get_levels** -- pivots (daily/weekly/monthly), Camarilla, round numbers,
  Fibonacci on the last external leg, ONE merged ladder of the nearest levels
  above/below with what meets there. APA flip levels (H4+, more than 2 touches,
  flip confirmed, single candle structure) and APA flip entry type 2 (flip zone,
  multiple candle structure, breakout, return, higher-timeframe wick overlap).
- **get_session** -- sessions, killzones, Asian range, London/NY opening ranges,
  session highs/lows today and yesterday, opens, London swept Asia, Judas swing,
  CBDR, holiday, rollover. 24/7 symbols have no sessions.
- **get_news** -- events for both currencies, minutes to the next high-impact one,
  blackout now, last high-impact release (actual/forecast/previous, surprise,
  price reaction). Synthetics are not news-driven.
- **get_intermarket** -- currency strength ranking, correlations (and breaks),
  DXY proxy, gold, USDJPY.
- **get_chart_patterns** -- double top/bottom, head and shoulders,
  triangles/wedges, completed harmonics (H1+).
- **get_summary** -- structure bias D1/H4/H1/M15 (weighted votes shown),
  confluence factors with votes, ATR stop sizes vs the broker minimum, APA
  monthly and weekly cycles,
  timeframes agreeing, the FTA ahead, which entry-module parts are present.
- **get_all_analysis** -- all 15 groups in one call.

Account tools: **get_open_trades** (R, best/worst, breakeven allowed,
invalidation), **get_symbol_info**, **get_position_size**, **get_deal_history**,
**ping_ea**.

Older names still answer (saved strategy skills use them): get_structure and
get_swing = get_market_structure, get_patterns = get_candles. The 3.x tools that
were duplicates of these groups (46 endpoints before, e.g. get_ict, get_confluence,
get_pivots) were merged into the groups above.
