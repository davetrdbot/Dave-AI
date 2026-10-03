# EA market structure: the list, regrouped (EA 3.6)

**Rule for every timeframe:** each timeframe is computed **only from its own raw bars**. M5 is
built from M5 candles, H1 from H1 candles, and so on. No timeframe borrows another timeframe's
numbers, so H1 and weekly data are never used to compute M5.

Levels that belong to a higher timeframe (yesterday's high, the weekly open, and so on) still
matter. They sit in their own endpoint, `reference_levels`, each one read from that higher
timeframe's own bars and **never mixed into** a timeframe's structure.

Endpoint: `market_structure` (one timeframe per request; in `all` too). Tool: `get_market_structure`.

Sources researched: ICT / SMC definitions on the [LuxAlgo concept library](https://www.luxalgo.com/library/concept/)
(internal vs external structure, internal vs external range liquidity, CISD, mitigation block,
rejection block, breaker, trendline liquidity, buy- and sell-side liquidity), and the MQL5 docs on
[timeseries access](https://www.mql5.com/en/docs/series/timeseries_access) and
[CopyRates](https://www.mql5.com/en/docs/series/copyrates).

---

## 1. STRUCTURE  (`structure`)

| Concept | Field | Rule used |
|---|---|---|
| External (swing) structure | `external` | Swings with 5 bars each side: the main skeleton. |
| Internal structure | `internal` | Swings with 2 bars each side: the small swings inside one external leg (timing). |
| Trend | `external.trend`, `internal.trend` | Direction of the latest body-close break, else HH+HL / LH+LL. |
| BOS | `last_break.type = BOS` | Body close beyond a swing, with the trend that came before it. |
| CHoCH | `last_break.type = CHOCH` | Body close beyond a swing, against the trend that came before it. |
| Strong high / low | `strong_low` / `strong_high` | The extreme the breaking leg started from. Protected; the idea dies if it goes. |
| Weak high / low | `weak_high` / `weak_low` | The leg's extreme since the break. Unprotected; it is the target. |
| Layers aligned | `aligned` | External and internal trend agree. If they disagree, it is a pullback, not a reversal. |
| MSS | `mss` | A CHoCH delivered with displacement (a big-bodied candle at the break). |
| CISD | `cisd` | A body close through the **open** of the first candle in the last run of opposite candles into an extreme. Fires earlier than CHoCH. |
| Validation | `validation` | The broken level that confirmed the move. |
| Invalidation | `invalidation` | The opposite swing behind the break. A close beyond it means the idea is wrong. |
| Shift / transition | `shift` | Price closed back beyond the invalidation: SHIFT if new swings formed after it, TRANSITION if not yet. |
| Reclaim | `reclaim` | The extreme before the shift, and whether price took it back. |
| Dealing range | `range` | Last external swing high/low, equilibrium, premium/discount, position 0–1, OTE 62–79%. |

## 2. LIQUIDITY  (`liquidity`), with all its types together

| Concept | Field | Rule used |
|---|---|---|
| External range liquidity | `external_range` | Buy-side above the range high, sell-side below the range low. |
| Resting pools | `buy_side_pools`, `sell_side_pools` | Untaken swing highs above / lows below price, nearest 3 each. |
| Equal highs / lows | `equal_highs`, `equal_lows` | Two swings within 10% of the average bar, not taken yet. |
| Trendline liquidity | `trendline` | 3 rising lows (stops below) or 3 falling highs (stops above) on one line: level now, broken or not. |
| Sweep | `sweeps` | Wick through a swing, close back inside. |
| Swing failure (SFP) | `sweeps[].swing_failure` | The sweeping candle is itself the new swing extreme. |
| Run | `runs` | Close through a swing: the liquidity was taken, not rejected. |
| Inducement | `inducement` | The last internal pullback swing inside the external leg; taken or not. |
| Liquidity engineering | `engineering` | Last sweep, then the furthest-most deviation (FMD), then whether a CHoCH back confirmed. |
| Liquidity void | `voids` | Long one-sided candles (range > 2× average, body > 70%) not yet traded back to their middle. |
| Draw on liquidity | `draw_on_liquidity` | The nearest untaken pool in the external trend's direction. |

## 3. ZONES  (`zones`): every zone carries `fresh`, `mitigated_pct`, `invalidated`

| Zone | Rule used |
|---|---|
| ORDER_BLOCK | Last opposite candle before the external break. |
| BREAKER | A swing that **swept** the prior extreme, then had its origin candle closed through; role flipped. |
| MITIGATION_BLOCK | Same flip, but the swing **failed** to reach the prior extreme (no sweep). |
| REJECTION_BLOCK | A swing extreme with a wick of at least 50%; the zone is the wick beyond the body. |
| FVG | 3-candle gap, at least 30% of the average bar. |
| IFVG | An FVG price closed through; it now acts the opposite way. |
| BPR | A bullish and a bearish FVG within 20 bars that overlap; the zone is the overlap. |
| ENGULFING_AOL | Type 1 engulfing area (two same-colour candles, the second closing beyond the first's extreme). |
| FLIP | A level touched 2+ times, later closed through. |

## 4. CONFIRMATION  (`confirmation`, last closed bar)

Displacement, its side, engulfing, rejection (pin).

## 5. REFERENCE LEVELS  (`reference_levels`), kept apart

| Group | Fields |
|---|---|
| `daily` / `weekly` | open, prev_high, prev_low, prev_close (`monthly`: open, prev_high, prev_low) |
| `ranges` | avg_daily_range_14d, today_range, today_pct_of_avg |

The daily-range numbers moved here **out of** `risk_metrics`, so `risk_metrics` now uses only its own timeframe.

---

## What else changed in 3.6 and why

- **Internal and external structure** were not separated before: one swing size was used for everything.
- **Strong / weak highs and lows** are new: they tell Dave which level protects the trade and which is the target.
- New concepts found in the research and added: CISD, MSS, swing failure pattern, trendline liquidity, liquidity voids, draw on liquidity, mitigation block, rejection block, inverse FVG, balanced price range.
- Zones now report **how deep** price went into them (`mitigated_pct`) and whether they're **dead** (`invalidated`), not just fresh or used.
- Breaker vs mitigation block now follows the definition: a sweep makes a breaker, no sweep makes a mitigation block.

## Still multi-timeframe on purpose (named, not hidden)

| Endpoint | What it reads, and why |
|---|---|
| `price` | Day/week/month highs and lows. It is a price snapshot. |
| `pivots` | D1/W1/MN1, because that is what a pivot is. |
| `ict` | The daily/weekly open for the AMD read. |
| `mtf` / `correlation` / `strength` / `heatmap` / `macro` | These compare timeframes or symbols by design. Switch them off in *What Dave analyses* if you want purely single-timeframe data. |
