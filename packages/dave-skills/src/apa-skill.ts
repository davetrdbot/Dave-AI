import { createSkill, listSkills, updateSkillContent, type Skill } from "./skill-store.js";

/**
 * APA -- Advanced Price Action (the trader: "the transcription I sent, create a skill and add it to
 * the bot"). Built from the trader's video transcript (youtu.be/jLRm2poYbec): seven entry models on
 * pure price action, a higher-timeframe key level, a lower-timeframe confirmation, liquidity first.
 * Written as Dave's playbook, not a copy of the video.
 */
export const APA_SKILL_NAME = "APA -- Advanced Price Action (7 entry models)";

export const APA_SKILL_CONTENT = `# APA -- Advanced Price Action (Lowkey Forex Trader)

This is THE strategy. Follow it step by step; never improvise a different setup (a "possible pullback", an indicator signal) and call it APA. Every scan carries an **APA STRUCTURE** block computed from the candles -- trend, last BOS, VALIDATION and INVALIDATION points, SHIFT / TRANSITION / RECLAIM, liquidity sweeps, equal highs/lows, and the FRESH (unconsumed) zones: Type 1 engulfing AOLs, FVGs, order blocks. Read the setup from THAT block. RSI, MACD, Ichimoku, Bollinger and the other endpoints are background only -- never the reason for an APA trade.

## 1. The core idea: liquidity
Price moves to fill orders. It travels from one **area of liquidity (AOL)** to the next. Trade only from AOLs -- outside them there is no order flow and no edge.
Every AOL has two points:
- **Validation point** -- where the market confirmed which side is in control (the level whose break proved dominance).
- **Invalidation point** -- a CLOSE beyond it means dominance has shifted. That is where the idea is wrong. Your stop goes beyond it (or beyond the FMD, below).

## 2. Market structure
- Uptrend: higher highs and higher lows. Downtrend: lower highs and lower lows. Range: sideways.
- **Pure** trend: price keeps going without returning to the AOL (strong liquidity ahead).
- **Different** trend: price retraces DEEP into the AOL (into the validation/invalidation zone) to collect liquidity, then continues. Expect this; it is not a reversal.

## 3. Market shift (when a trend changes)
- **Shift point** = the previous trend's invalidation point. Bullish trend: a CLOSE below the significant support. Bearish trend: a CLOSE above the significant resistance. A close through it = the market may reverse.
- **Transition** = it closed through the shift point but has NOT formed new structure the other way yet. Not confirmed -- no trade on a transition alone.
- **Reclaim point** = the previous extreme. If, after the shift, price closes back beyond it, the OLD trend is back in control -- trade with the old trend.
- A shift leaves a new formation; that formation is the new AOL (your point of interest).

## 4. Liquidity engineering (the trap before the real move)
Institutions push price to the obvious level (support, demand, discount / resistance, supply, premium), sweep the early traders, make it look like a flip, sweep the flip traders too -- THEN move the real way. So: **buy at support/demand/discount and sell at resistance/supply/premium only AFTER the liquidity has been engineered.**
Spot it with all four:
1. a LEVEL where price clearly turned before (the overthrow level);
2. a **thrust candle** -- above the level and back inside it (the sweep);
3. the **FMD (furthest-most deviation)** -- the extreme of that sweep. The stop loss goes beyond the FMD;
4. a **CHoCH** (change of character) back in your direction on the lower timeframe.
In the APA STRUCTURE block this shows as a "sweep" plus a fresh shift/BOS the other way.

## 5. Areas of liquidity -- Type 1 engulfing
- **Bearish**: two bearish candles; the second wicks ABOVE the first's high and closes BELOW the first's close/low, engulfing it wick and all. Powerful sell zone.
- **Bullish**: two bullish candles; the second wicks BELOW the first's low and closes ABOVE the first's close/high. Powerful buy zone.
Price coming back to a fresh one = point of interest; confirm before entering.

## 6. Liquidity consumption
An AOL is fresh until price has used **50% of it**. A consumed zone is no longer a point of interest -- move on to the next fresh one (the block marks consumed zones). Consumption runs down the timeframes: a higher-timeframe AOL is reached through shifts and consumption on the lower ones.

## 7. Timeframes: bias, cycles, FTAs
- Trade only when **at least two timeframes speak the same language** (e.g. H4 bullish and H1 bullish).
- **Constant timeframe** = where the AOL and bias come from. **Situational timeframes** = where you refine and enter.
  - Monthly cycle: Monthly -> Daily -> H1 -> M15 -> M3/M5.
  - Weekly cycle: Weekly -> H4 -> M30 -> M5 -> M3.
  - On fast synthetics use the same ladder lower: H4 (constant) -> H1 -> M15 -> M5/M1.
- Read right to left: price can't reach a daily AOL from H1 before finishing the H4 price action.
- **FTA (first trouble area)** = a higher timeframe's AOL standing in the way of your trade. The higher the timeframe, the stronger the area. FTAs are where you TAKE PROFIT or lock it (stop to breakeven / partial). If price reaches the FTA and the higher timeframe fails to shift, expect a reversal.

## 8. The five entry modules
**A. Shift entry.** Constant TF: mark the AOL. Wait for price to return to it. On situational TF 1 wait for a SHIFT -- it leaves a new formation = the new AOL. If that stop is too wide, refine on a lower TF (an unconsumed inside zone, or liquidity engineering / a flip). Enter there.
**B. Flip entry type 1.** On H4 or higher, a level touched by 2+ swing points. Price breaks it -> it is a flip zone. Before the break, find the single candle structure at the level; enter on the retest using consumption + liquidity engineering.
**C. Flip entry type 2.** Same flip logic; entry taken as usual inside that flip area once it is retested and confirmed.
**D. FTA entry.** Shift on one cycle timeframe (e.g. H1) -> mark the formation. Check the FTA timeframe (H4): a real shift there validates the H1 formation (high probability); only a transition there = caution, no trade or reduced confidence. Then enter as usual.
**E. Liquidity engineering entry.** Constant TF (Daily/H4): mark the AOL. Situational TF 1: look for liquidity engineering near the invalidation zone; wait for the tap. Situational TF 2 (lower): liquidity engineering again. Both confirmed -> enter. Stop beyond the FMD.

## 9. Running it with your tools -- exactly when to do what
- **You find a fresh AOL (engulfing AOL, OB, FVG, flip zone) that price hasn't reached** -> \`mark_level\` it at once (name the module, the side, the validation and invalidation points). A level you found and didn't mark is a trade you'll miss.
- **The bias is clear on two timeframes and the AOL is fresh** -> place the order AT the AOL: \`BUY_LIMIT\` at a bullish AOL below price, \`SELL_LIMIT\` at a bearish AOL above price. Stop beyond the invalidation point / FMD; take profit at the next opposing AOL or FTA. Price not there yet = a limit, not a skip.
- **The setup needs something to happen first** (the sweep, then the CHoCH, then the retest) -> \`setup_create\` with those steps in order and \`cancelIf\` = a close beyond the invalidation point.
- **It depends on a candle close or a session** (the H1/H4 close that would confirm the shift, a session open) -> \`set_reminder\` for that time with the AOL, the module and what you are waiting for.
- **Price is at the AOL with the sweep and the CHoCH done right now** -> enter at market (BUY/SELL), stop beyond the FMD.
- **A pending limit that price ran away from** -> you'll get a STALE LIMIT reminder: if the idea is still valid, cancel the limit and enter at market; if the target is already used up, cancel and say "missed entry, no chase".
- **Transition only, consumed zone, timeframes disagreeing, or no AOL near price** -> no entry. Mark the next fresh AOL instead and set the reminder.
- **Show it**: \`draw_setup\` -- AOL, validation, invalidation, sweep/FMD, shift, entry, SL, TP.

## 10. Managing the trade
- The stop sits beyond the invalidation point / FMD. A losing trade is held to it -- the market engineers liquidity against you before the real move.
- Reaching an FTA or the opposing AOL = take the profit or lock it (stop to breakeven, trail it). A winner is never allowed to turn into a loss.
- On a stop alert, if the AOL is still valid and the real FMD is a little further, the stop may be extended once.
`;

/** Adds the skill to an account that doesn't have it; keeps its text current if it's already there. */
export function seedApaSkill(userId: string): Skill {
  const existing = listSkills(userId).find((s) => s.name === APA_SKILL_NAME);
  if (!existing) {
    return createSkill(userId, {
      name: APA_SKILL_NAME,
      description: "APA (Lowkey Forex Trader): areas of liquidity with validation/invalidation, market shift (shift/transition/reclaim), liquidity engineering (thrust, FMD, CHoCH), Type 1 engulfing AOLs, consumption, timeframe cycles and FTAs, and the 5 entry modules; when to mark levels, place limits, set reminders and setups.",
      content: APA_SKILL_CONTENT,
      source: "built-in",
    });
  }
  return existing.content === APA_SKILL_CONTENT ? existing : updateSkillContent(userId, existing.id, APA_SKILL_CONTENT);
}
