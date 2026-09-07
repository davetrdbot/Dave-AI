---
name: ea-analysis
description: All 46 real market-analysis endpoints your connected MT5 EA computes on demand — what each one tells you, and when to reach for it. DAVEMA is retired; this is the real replacement, computed locally by the EA itself, for ANY symbol in Market Watch.
use_when: You're analyzing a symbol before deciding whether a setup is real, explaining your reasoning to the user, or need a specific piece of market structure/momentum/liquidity/etc data.
---

# Your Real Market Analysis Tools (46 endpoints, all real, all on-demand)

DAVEMA (the old external API) is retired. Every one of its 46 endpoints is
now computed LIVE by your own connected MT5 EA, for ANY symbol in its
Market Watch — not just the chart it happens to be attached to. Each is a
real, separate tool call (`get_<endpoint>`, plus `get_all_analysis` and
`ping_ea`) — you pay for exactly the analysis you ask for, nothing runs
automatically in the background. Every call needs `symbol` (required) and
`timeframe` (optional, defaults to M15).

These are real computed numbers from real price history, not invented —
when a tool result is missing a value or says "not enough real history
loaded yet," that's the EA being honest about a genuinely fresh symbol,
not a bug to paper over.

## Core price & structure — start here for most setups

- **get_price** — bid/ask/spread, day/week/month/52w high-low, swap, lot
  size limits. The raw facts before you reason about anything.
- **get_structure** — HH/HL/LH/LL trend classification, BOS (break of
  structure), CHoCH (change of character), MSS, CISD, dealing range,
  premium/discount, OTE zone. Your primary "what is price actually doing"
  read.
- **get_zones** — supply/demand zones with freshness, strength, and
  mitigation %. Where price is likely to react.
- **get_liquidity** — BSL/SSL levels, equal highs/lows, real sweep
  detection, liquidity voids. Where stops are likely resting.
- **get_order_blocks** — bullish/bearish order blocks, mitigated status,
  distance from current price.
- **get_inducement** — IDM levels and whether they've been taken; tells
  you the likely NEXT liquidity target.
- **get_premium_discount** — where price sits in its dealing range (deep
  premium/premium/discount/deep discount), OTE zone, directional bias.

## Trend & momentum

- **get_trend** — MA/EMA alignment, golden/death cross, bias score.
- **get_momentum** — RSI/MACD/Stochastic/CCI/Williams %R blended into one
  bull/bear read.
- **get_volatility** — ATR, Bollinger Bands, Keltner Channel, expansion/
  contraction, volatility regime (real fix: EA now waits for MT5 to
  sync history on a fresh symbol instead of failing immediately).
- **get_ichimoku** — full cloud (tenkan/kijun/senkou A+B/chikou), TK
  cross, signal score.
- **get_regime** — is this symbol trending, ranging, or transitional
  right now, plus a suggested trading style for that regime.
- **get_divergence** — real RSI/MACD/Stochastic divergence detection,
  regular and hidden, with confirmation.

## Volume & order flow

- **get_volume** — current vs average, bull/bear volume delta, spikes.
- **get_orderflow** — buy/sell volume delta, absorption, climax, stop
  runs, momentum ignition.
- **get_tape** — real tick-by-tick up/down ratio and tape bias.
- **get_tape_flow** — cumulative volume delta, aggressive buyer/seller
  flow.
- **get_market_profile** — POC, value area high/low, price vs value
  area, profile shape (D-shape vs P-shape).

## Levels & targets

- **get_fibonacci** — retracement/extension levels, nearest level, OTE
  zone, golden-ratio bounce detection.
- **get_pivots** — classic/Fibonacci/Camarilla/weekly/monthly pivots.
- **get_levels** — round-number/psychological levels, 52-week distance.
- **get_gann** — Gann fan ratios, nearest Gann level, Square of 9.
- **get_swing** — real swing highs/lows with bar index and timestamp.
- **get_fractal** — Williams fractal up/down points.

## Patterns & setups

- **get_candles** — the last 10 real candles with body/wick ratios, gap
  and imbalance detection.
- **get_patterns** — candlestick pattern recognition (engulfing, stars,
  hammers, dojis, ...) with a strongest-pattern call and reliability.
- **get_harmonic** — Gartley/Bat/Butterfly/Crab pattern detection with
  XABCD ratios and PRZ.
- **get_elliott** — current wave count, impulse/correction, wave target
  and invalidation.
- **get_ict** — the big one: FVG/iFVG, order blocks, breaker blocks,
  killzones, silver bullet window, Judas swing, AMD phase, asian range,
  OTE zone, all in one call.
- **get_wyckoff** — accumulation/distribution/markup phase, spring/UTAD
  events, effort-vs-result.

## Context — session, news, macro, sentiment

- **get_session** — Tokyo/London/NY/Sydney status, overlaps, time to
  next session, Asian range.
- **get_news** — real upcoming economic-calendar events for this pair's
  currencies, high-impact count, news-blackout window. Check this before
  sizing into anything near a high-impact release.
- **get_macro** — daily/weekly change, DXY/gold/USDJPY proxies, risk-on/
  risk-off regime.
- **get_correlation** — this symbol's correlation vs EURUSD/DXY proxy,
  safe-haven status.
- **get_strength** — currency strength for this pair's own base/quote.
- **get_heatmap** — currency strength across all 8 majors at once.
- **get_sentiment** — a composite fear/greed-style score blended from
  RSI + MACD + bull-bar percentage.
- **get_seasonality** — most volatile hour of day, hourly average range,
  day-of-week/month context.

## Sizing, cost, and confidence

- **get_confluence** — multi-signal agreement score (MA/RSI/MACD/ADX/
  price-action) with direction and strength. Good gut-check before
  committing to a read.
- **get_risk_metrics** — ATR-based SL/TP levels, R:R ratios, pip value,
  recommended lot size per 1%/2% risk. Cross-check against goal.yaml's
  actual account-size-aware sizing before you size a real trade.
- **get_spread_analysis** — spread vs ATR, cost rating, whether the
  spread makes this symbol tradeable right now.
- **get_mean_reversion** — z-score vs the 20-period mean, overextension,
  revert-long/short signal.
- **get_synthetic** — Boom/Crash/Volatility spike due/overdue detection
  and probability — use this specifically on synthetic-index symbols
  (the Synthetic pair group), meaningless on real forex/crypto.
- **get_backtest** — a quick real MA20/50-cross backtest over the loaded
  history (win rate, net pips). A sanity check, not a strategy.

## Everything at once, and the health check

- **get_all_analysis** — every one of the 44 analytical endpoints above,
  in ONE response. Use when you genuinely need a full market read (e.g.
  a fresh setup search on a new symbol) rather than calling several
  individually — cheaper and faster than 10+ separate round trips.
- **ping_ea** — trivial health check, no market data, just confirms the
  connected EA is alive and responsive. Use if `/connection` or another
  tool suggests the EA might be unreachable.

## How to actually use this well

- Don't call all 46 on every message — pick the ones that answer the
  actual question in front of you. `get_confluence` or `get_all_analysis`
  when you need a broad read; a specific endpoint when you need one
  specific thing.
- Cross-reference, don't cherry-pick: a real setup usually has structure
  (get_structure/get_zones/get_liquidity), a trend/momentum read that
  agrees, and no major news risk (get_news) sitting on top of it — not
  just one favorable number.
- These are read-only market data, not trading rules. What counts as "a
  good setup" is governed by goal.yaml and your own judgment, not by any
  single endpoint's output.
