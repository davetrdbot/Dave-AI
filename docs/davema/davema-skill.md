---
name: davema
description: Market Intelligence API — 46 SMC/ICT endpoints, direct HTTP access. Use this to fetch any market data, structure, indicators, or analysis for a symbol/timeframe. Call directly via HTTPS — does NOT require DAVESBX or any sandbox.
use_when: Any time you need live market data, technical structure, indicators, or trade-decision inputs for a symbol.
---

# DAVEMA — Direct HTTP Skill

DAVEMA is a plain REST API. Call it directly with a normal HTTPS request — you do NOT need DAVESBX, a terminal, or any sandbox to use it. Any tool/runtime with HTTP access (fetch, curl, requests, axios) can call it straight away.

## Base URL
```
https://srzaqmvrnfeduivqvbgv.supabase.co/functions/v1/v1
```

## Auth
Send your key in the `x-api-key` header on every request except `/ping`.
```
x-api-key: sk_live_xxxxx
```

## Request pattern
```
GET {base}/{endpoint}?symbol=EURUSD&tf=M15
GET {base}/{endpoint}?symbol=EURUSD&tf=M15&from=<ISO>&to=<ISO>   (history mode)
```
`tf` defaults to `M15` if omitted. Adding `from`/`to` (ISO-8601) returns a time series instead of the live snapshot, up to 2000 rows, oldest first — `{ timestamp, value }` per row.

## Response envelope (every endpoint)
```json
{
  "symbol": "EURUSD",
  "timeframe": "M15",
  "timestamp": "2026-08-30T10:04:57Z",
  "endpoint": "structure",
  "data": { ... }
}
```
Always read `response.data` — never assume field order.

## Direct call example (no sandbox needed)
```javascript
const res = await fetch(
  "https://srzaqmvrnfeduivqvbgv.supabase.co/functions/v1/v1/structure?symbol=EURUSD&tf=M15",
  { headers: { "x-api-key": "sk_live_xxxxx" } }
);
const { data } = await res.json();
```
```bash
curl -H "x-api-key: sk_live_xxxxx" \
  "https://srzaqmvrnfeduivqvbgv.supabase.co/functions/v1/v1/structure?symbol=EURUSD&tf=M15"
```

## Status codes
| Code | Meaning | Fix |
|---|---|---|
| 200 | Success | — |
| 400 | Missing/malformed params | Always send `symbol`; `tf` defaults to M15 |
| 401 | Missing/invalid/revoked key | Check key is active |
| 404 | Unknown endpoint, or no live data | Confirm the EA is pushing that symbol+tf |
| 500 | Upstream DB error | Retry with backoff |

---

## Full endpoint list (46)

**01 `/price`** — bid, ask, mid, spread_pts, spread_pips, day_high/low, day_range_pips, prev_close/open, change_pts/pct, week/month high/low, hi_52w, lo_52w, digits, point, pip, tick_value, tick_size, swap_long/short, min_lot, max_lot, lot_step

**02 `/structure`** — trend (HH_HL/LH_LL/HH_LL/LH_HL), bos, choch, mss, cisd, idm, qml, hh/hl/lh/ll, eq_highs/lows, swing_high/low, prev_high/low, dealing_range_high/low, equilibrium, premium_discount, ote_zone_high/low, ce, internal/external_bos, bars_since_bos, trend_strength, swing_highs/lows_array

**03 `/zones`** — supply[], demand[] (top, bot, bar, fresh, strength, tests, body_ratio, mitigation_pct), supply/demand_count, nearest_supply/demand, price_in_zone, zone_at_price, strongest_zone

**04 `/liquidity`** — bsl[], ssl[] (level, bar1, bar2, dist_pips), bsl/ssl_count, bsl/ssl_swept, nearest_bsl/ssl, idm, irl[], erl[], liquidity_void_above/below, equal_highs/lows, most_recent_sweep

**05 `/trend`** — bias (STRONG_BULL..STRONG_BEAR), score (-5 to +5), slope_20/50, ma20/50/200, ema9/21, price_vs_ma20/50/200, ema9_vs_ema21, ema_cross, ma_rising_20/50/200, golden/death_cross, price_above_all_mas, ma_alignment, dist_ma200/50_pips

**06 `/momentum`** — rsi, rsi_prev, rsi_zone, rsi_slope, macd_main/signal/hist, macd_dir/cross, macd_above_zero, macd_hist_growing, stoch_k/d, stoch_zone/cross, cci, cci_zone, williams_r/zone, roc, momentum_score, max_score, overall_signal, bull/bear_signals_count

**07 `/volatility`** — atr, atr_pips, atr_state, atr_percentile, atr_vs_avg, bb_upper/mid/lower, bb_width_pips, bb_position, bb_pct_b, bb_squeeze, kc_upper/lower, kc_position, expanding, contracting, historical_vol_10, regime

**08 `/volume`** — current, avg_20/50, state, vs_avg20, trending_up, bull_vol, bear_vol, delta_pct, vol_bias, vol_spike, vol_climax, rising_price_rising/falling_vol, last_10[]

**09 `/ichimoku`** — tenkan, kijun, senkou_a/b, chikou, cloud (color, top, bottom, thickness_pips, price_inside), price_vs_cloud/tenkan/kijun, tk_cross, tenkan/kijun_slope, chikou_vs_price/cloud, flat_kijun, kijun_support/resistance, kumo_twist, signal, score, max_score, dist_tenkan/kijun_pips, all_conditions_bull/bear

**10 `/fibonacci`** — high, low, range_pips, swing_up, f0/236/382/500/618/786/100, e127/161/200/261, nearest_level/price, dist_to_nearest_pips, pos_in_range, price_zone, ote, in_ote, retracement_depth_pct, confluence_with_ma, golden_ratio_bounce

**11 `/candles`** — last 10 bars: t, o, h, l, c, v, d, body, upper/lower_wick, body_ratio, wick_ratio, size_pips, size_vs_atr, type, gap, gap_type, is_imbalance

**12 `/patterns`** — single (doji, hammer, inverted_hammer, shooting_star, marubozu, pin_bar, spinning_top), double (engulfing, harami, harami_cross, tweezers, piercing_line, dark_cloud_cover, inside/outside_bar), triple (morning/evening_star, three_white_soldiers/black_crows, three_inside_up/down), strongest, bias, reliability

**13 `/ict`** — fvg[] (type, top, bot, ce, filled, bar), ifvg[], bpr, vi[], ob (type, high, low, ce, mt, bar, valid, tested), breaker, mb, sweep, bsl[], ssl[], idm, ndog, nwog, mop, asian_range, killzone, silver_bullet, silver_bullet_window, judas_swing, amd_phase, cbdr, dol, dol_dir, premium_discount, ote_zone, poi_count, smt, mmbm, mmsm

**14 `/wyckoff`** — phase, sub_phase, event, schematic, avg_vol, recent_vol, vol_ratio, effort_result, trading_range_high/low, breakout_direction, cause_bars, recent_range, prev_range

**15 `/divergence`** — rsi_bull/bear_div, rsi_hidden_bull/bear, macd_bull/bear_div, macd_hidden_bull/bear, stoch_bull_div, price_high1/2, price_low1/2, rsi_now, rsi_at_prev_high/low, strongest, confirmed, bars_since_div

**16 `/session`** — current, tokyo, london, new_york, sydney, overlap, overlap_type, hour_utc, min_utc, to_london/ny/tokyo/sydney_min, silver_bullet_window, cbdr_active, high_impact_hours, session_open_price, session_high/low, asian_range_high/low/pips, session_time_elapsed_min

**17 `/pivots`** — classic/fibonacci (p, r1-3, s1-3), camarilla (r1-4, s1-4), weekly (p, r1, s1, high, low), monthly (p, r1, s1), pdh, pdl, pdc, pdo, pwh, pwl, nearest_pivot, dist_to_nearest_pips, price_vs_pivot

**18 `/levels`** — nearest, above, below, mid, dist_pips, step_size, big_figure, half_figure, dist_to_big/half_figure_pips, psychological_level, magnet_level, nearby_rounds[], hi_52w, lo_52w, dist_to_52h/l_pips

**19 `/orderflow`** — delta, bias, buy_vol, sell_vol, consecutive, consecutive_dir, absorption_bars, momentum_acceleration, climax_buy/sell, initiative_buyers/sellers, responsive_buyers/sellers, stop_run, momentum_ignition

**20 `/confluence`** — score (0-100), direction, strength, bull_signals, bear_signals, total_signals, agreement_pct, confidence, signal_breakdown (ma_trend, rsi, macd, adx_trend, price_action)

**21 `/risk_metrics`** — atr_pips, sl_1x/1.5x/2x/3x_pips, tp_1.5x/2x/3x/5x_pips, rr_1.5/2/3, pip_value, spread_pips, spread_pct_of_sl, daily_range_pips, atr_pct_of_daily_range, max_recommended_sl_pips, position_sizing (lot_per_1pct/2pct_risk)

**22 `/synthetic`** — type (BOOM/CRASH/VOL/STORM/FLAME/HW_INDEX/FOREX), tick_interval_number, spike_dir, spike_count, bars_since_spike, avg_between, is_due, is_overdue, estimated_bars_to_spike, spike_probability, dominant_dir, micro_trend, spike_threshold, avg_candle_range, volatility_class, recent_spikes[]

**23 `/elliott`** — wave, impulse, pivots, ab/bc/cd_ratio, current_wave_high/low, wave_target, wave_invalidation, correction_type, confidence, wave_degree, bars_in_wave

**24 `/correlation`** — ret_5bar/20bar, vs_eurusd, corr_label, vs_dxy, risk_on, safe_haven, momentum_sync, positive_pairs, negative_pairs

**25 `/strength`** — base, quote, bias, ret_10bar, base/quote_score, strength_diff, trend_alignment, currency_scores (USD/EUR/GBP/JPY/CHF/AUD/CAD/NZD), strongest/weakest_currency, best_pair_to_trade

**26 `/heatmap`** — day/week/month/quarter/year_chg, heat (-3 to +3), color, momentum_direction, above_avg_move, day_rank_in_20

**27 `/fractal`** — up[], down[] (price, bar, strength), up/down_count, last_up/down, fractal_broken_up/down, nearest_fractal_pips, fractal_direction_bias

**28 `/harmonic`** — pattern, direction, xa/ab/bc/cd_ratio, found, completion_pct, prz_high/low, stop_loss, target_1/2, reliability, x/a/b/c/d_point

**29 `/mean_reversion`** — z_score, signal, mean, stdev, dist_from_mean_pips, regression_pips, bands_2std/1std_high/low, outside_1std/2std, reversion_probability, mean_slope

**30 `/tape`** — consecutive, direction, pressure, accelerating, decelerating, bull/bear_mom, tape_score (0-100), exhaustion, reversal_candle, first_opposing_bar, momentum_shift

**31 `/seasonality`** — day, day_tendency, time_tendency, end_of_month/quarter, month, quarter, week_of_year, day_of_month, best_hours_utc[], avoid_hours_utc[], typical_range_pips, above_typical_range, monthly_bias

**32 `/spread_analysis`** — spread_pts/pips, state, normal_est, pct_of_normal, vs_atr_pct, round_trip_cost_pips, high_spread_warning, liquidity_level, session_context

**33 `/gann`** — swing_low, swing_bar, g1x8/4/2/1, g2x1/4x1/8x1, position, sq9_current/next/prev, sq9_ring, time_cycle_90/180/360, days_from_swing, gann_fan_resistance/support

**34 `/market_profile`** — poc, va_high/low, range_hi/lo, price_pos, value_area_width_pips, poc_dist_pips, developing_poc, virgin_poc, single_prints[], imbalance, tpo_count, balance_point

**35 `/tape_flow`** — block_trades[] (bar, vol, dir), block_count, absorption_bars, avg_vol, institutional, flow_bias, large_buyer/seller, iceberg_order, stop_run, momentum_ignition

**36 `/macro`** — base/quote_cb, base/quote_rate, base/quote_stance, rate_diff, carry, macro_dir, risk_environment, usd_bias, global_cycle, quarter, end_quarter

**37 `/news`** — next_event, mins_away, impact, high_impact_soon, blackout_period, post_news_volatility, hour_utc, next_high_impact_event/mins, events_today[] (name, time_utc, impact)

**38 `/sentiment`** — pos_in_52w_range, retail_bias, smart_money_bias, rsi_sentiment, hi_52w, lo_52w, cot_proxy, fear_greed_index (0-100), fear_greed_label, commitment_proxy

**39 `/regime`** — regime, adx, di_plus/minus, trend_dir, trending, ranging, atr_ratio, regime_change, choppiness_index, trend_strength, bars_in_current_regime

**40 `/backtest`** — bull/bear_setups, bull/bear_winrate, overall_winrate, avg_bull/bear_gain_pips, best_setup, expectancy_pips, sample_bars, total_trades

**41 `/swing`** — major/minor_swing_high/low, current_swing_dir, swing_size_pips, swing_age_bars, swing_leg_count, retracement_pct, at_fibonacci, stacked_fib, impulse_bars, pullback_bars, swing_target, swing_invalidation, projected_extension_pips

**42 `/order_blocks`** — bullish_obs[], bearish_obs[] (high, low, ce, mt, bar, fresh, tested, strength), breaker_blocks[], mitigation_blocks[], rejection_blocks[], nearest_ob, price_at_ob, ob_confluence, freshest_ob, strongest_ob, ob_count_bull/bear

**43 `/inducement`** — detected, level, type, bar, taken, post_idm_target, strength, multiple_idm[], trap_confirmed, liquidity_grab, bars_since_idm, idm_size_pips

**44 `/premium_discount`** — current_zone, equilibrium, position_pct, premium_zone, discount_zone, ote_zone, dealing_range_high/low, pd_arrays[], optimal_buy/sell_zone, price_in_premium/discount/ote/discount_ote, ce, dist_to_eq/range_high/low_pips

**45 `/all`** — every one of the 44 sub-objects above, in one response, for the given symbol+tf

**46 `/ping`** — no auth required, returns `{ status: "ok", time: <ISO> }`. Use this to health-check the API before relying on it.

---

## Recipes (call these directly, no sandbox required)

**Multi-timeframe bias check**
```javascript
async function get(endpoint, symbol, tf="M15") {
  const r = await fetch(`${BASE}/${endpoint}?symbol=${symbol}&tf=${tf}`,
    { headers: { "x-api-key": KEY } });
  return (await r.json()).data;
}
const h4 = await get("trend", "EURUSD", "H4");
const h1 = await get("trend", "EURUSD", "H1");
const m15 = await get("structure", "EURUSD", "M15");
// if h4.score >= 2 && h1.score >= 1 && m15.choch === "BULL" -> LONG bias
```

**Liquidity sweep + FVG entry**
```javascript
const liq = await get("liquidity", "EURUSD", "M15");
const ict = await get("ict", "EURUSD", "M15");
if (ict.killzone && liq.ssl_swept) {
  const gap = ict.fvg.find(g => g.type === "BULL" && !g.filled);
  if (gap) { /* BUY at gap.ce, invalidation liq.nearest_ssl.level */ }
}
```

**Score + size a setup**
```javascript
const c = await get("confluence", "XAUUSD", "H1");
const r = await get("risk_metrics", "XAUUSD", "H1");
if (c.score >= 75 && c.direction === "BULL") {
  const lots = r.position_sizing.lot_per_1pct_risk;
  // BUY lots @ SL r.sl_1_5x_pips, TP r.tp_3x_pips
}
```

**Watchlist scan (parallel, no sandbox)**
```javascript
const list = ["EURUSD","GBPJPY","XAUUSD","BOOM_100","VOL_80","CRASH_200"];
const rows = await Promise.all(list.map(async symbol => {
  const d = await get("confluence", symbol, "H1");
  return { symbol, score: d.score, dir: d.direction };
}));
rows.sort((a,b) => b.score - a.score);
```

**Correlation check before sizing**
```javascript
const corr = await get("correlation", "GBPUSD");
if (corr.vs_eurusd > 0.7) { /* warn: correlated exposure with an existing EURUSD position */ }
```

## Notes
- Synthetics (Boom/Crash/Volatility) run 24/7 — ignore `/session` and `/macro` for them, lean on `/synthetic`, `/volatility`, `/structure` instead.
- Deriv synthetic symbols always contain `INDEX` in the name; Headway synthetics never do. Send the exact spelling your broker's MT5 Market Watch uses.
- Never poll faster than the EA's push interval — it wastes quota for no new data. Retry 5xx with backoff; treat 404 as "feed not live for that symbol/tf yet."
