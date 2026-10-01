import { createSkill, listSkills, updateSkillContent, type Skill } from "./skill-store.js";

/**
 * APA -- Advanced Price Action (the trader: "the transcription I sent, create a skill and add it to
 * the bot"). Built from the trader's video transcript (youtu.be/jLRm2poYbec): seven entry models on
 * pure price action, a higher-timeframe key level, a lower-timeframe confirmation, liquidity first.
 * Written as Dave's playbook, not a copy of the video.
 */
export const APA_SKILL_NAME = "APA -- Advanced Price Action (7 entry models)";

export const APA_SKILL_CONTENT = `# APA -- Advanced Price Action

Pure price action: structure, key levels, liquidity, confirmation. Indicators are context at most, never the reason.

## The story every APA trade must have (all five, in order)
1. **Bias on the higher timeframe (H4, H1).** Which way is structure breaking? Series of higher highs/lows = buys; lower highs/lows = sells. A break of structure (BOS) in the trend direction confirms it; the FIRST break against the trend is a change of character (CHoCH).
2. **A key level from one of the 7 models below**, closest to the latest break of structure, and still FRESH (price hasn't come back to it yet).
3. **Liquidity.** Find the equal highs/lows, swing points or trendline liquidity sitting just before the level. "If you can't see the liquidity, you are the liquidity." The best entries come AFTER that liquidity is swept -- early buyers/sellers get stopped out first.
4. **Confirmation on the entry timeframe (M15 / M5)** once price taps the level: a CHoCH on the lower timeframe, or a clear rejection candle (pin bar, engulfing). Then refine: the order block that caused that CHoCH is the entry (limit order) -- this keeps the stop tight.
5. **Risk plan.** Stop a few pips beyond the key level (or the refined swing). Target external liquidity / the opposite higher-timeframe level; at least 1:3. Bank 50% at 1:3 (or at the first liquidity), move the stop to breakeven, let the rest run to the higher-timeframe target.

No level reached = no trade. You don't force price; you wait at your level. When it gets there with the story intact, you take it without hesitation -- that's where the 1:8 to 1:17 trades come from.

## The 7 entry models

**1. OCL buy (open-close level, bullish).** In an uptrend, the line where one bullish candle CLOSES and the next OPENS (bodies only, wicks ignored) on H4/H1, nearest the last bullish BOS, with liquidity under it. On M15/M5 that level is a rally-base-rally zone. Wait for price to pull back into it, sweep the liquidity, and give a bullish CHoCH or rejection on M15/M5 -> BUY. SL a few pips below the OCL. TP: buy-side liquidity / the H4 high.

**2. OCL sell (bearish).** Mirror: the open-close line between two bearish candles after a bearish BOS. Pullback up into it, bearish CHoCH or rejection on M5 -> SELL. SL a few pips above. TP: the H4 lows (sell-side liquidity).

**3. Resistance "A" formation (sell).** In a bearish trend or at an H4 supply zone: price pushes up, then breaks a low (CHoCH down). The last candle BODY peak before that drop is the "A" -- clearest on a line chart. Wait for liquidity to form and be taken, then price to tap the A level -> M5 confirmation -> SELL. SL just above the A. Even stronger when the A sits inside an order block or supply. TP: 1:3 then the H4 lows.

**4. Support "V" formation (buy).** Mirror of the A: after a bullish BOS, the lowest candle BODY point (the bottom of the V, line chart) is support. Wait for a second BOS that creates liquidity below; price sweeps that liquidity and taps the V -> M5 confirmation -> BUY. SL just below the V. Counter-trend? Take profit at the opposing H4 supply, don't hold for the moon.

**5. SBR -- support becomes resistance (sell).** A level that held price up gets broken and price trades below it. Wait for the retest from below; at the level, an M5 CHoCH (break of the last M5 low) -> SELL. SL above the level. TP: the H1/H4 swing lows.

**6. RBS -- resistance becomes support (buy).** Mirror: resistance broken to the upside, retest from above, M5 bullish CHoCH -> BUY. SL below the level. TP: the higher-timeframe highs.

**7. QM -- Quasimodo (early reversal).** QM sell: uptrend, then the FIRST break of a swing low (CHoCH). Price forms liquidity, takes it, and returns to the LEFT SHOULDER -- the high before the high that broke down -- drawn as a horizontal level (line chart helps). Confirmation on M5 -> SELL; SL above the shoulder. QM buy: the mirror in a downtrend -- first break of a swing high, back to the left-shoulder low -> BUY. Catches reversals at the extreme; targets can be huge (1:10+), so bank 50% at 1:3.

## Rules that kill most traders (don't be one)
- **Entering on the first CHoCH candle without refining** -> wide stop -> stopped before the move. Refine to the M5/M15 order block.
- **Buying before the liquidity below is swept** (or selling before the highs above are swept): the setup looks right and you are the liquidity.
- **No level, no trade.** If price never reaches the level, the idea didn't happen -- find the next one.
- **Patience is the edge**; but when the level is hit and confirmed, act decisively -- multiple entries (one on the rejection, one on the refined CHoCH) are fine within the lot limits.
- **Hold to the plan.** Once in at a confirmed level with the stop beyond it, the stop decides. Markets fake before they pay.

## On synthetics (Boom/Crash/Volatility/Storm)
The same structure, levels and liquidity read applies; treat a spike as a liquidity sweep or an impulsive BOS. Respect the spike direction of the instrument (Boom spikes up, Crash spikes down) -- prefer APA entries that are WITH the spike.
`;

/** Adds the skill to an account that doesn't have it; keeps its text current if it's already there. */
export function seedApaSkill(userId: string): Skill {
  const existing = listSkills(userId).find((s) => s.name === APA_SKILL_NAME);
  if (!existing) {
    return createSkill(userId, {
      name: APA_SKILL_NAME,
      description: "Advanced Price Action: OCL buy/sell, resistance A, support V, SBR, RBS, QM -- HTF level + liquidity sweep + M5/M15 CHoCH, refined order-block entry, SL beyond the level, 50% at 1:3, rest to HTF liquidity.",
      content: APA_SKILL_CONTENT,
      source: "built-in",
    });
  }
  return existing.content === APA_SKILL_CONTENT ? existing : updateSkillContent(userId, existing.id, APA_SKILL_CONTENT);
}
