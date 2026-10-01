import { createSkill, listSkills, updateSkillContent, type Skill } from "./skill-store.js";

/**
 * APA -- Advanced Price Action (the trader: "the transcription I sent, create a skill and add it to
 * the bot"). Built from the trader's video transcript (youtu.be/jLRm2poYbec): seven entry models on
 * pure price action, a higher-timeframe key level, a lower-timeframe confirmation, liquidity first.
 * Written as Dave's playbook, not a copy of the video.
 */
export const APA_SKILL_NAME = "APA -- Advanced Price Action (7 entry models)";

export const APA_SKILL_CONTENT = `# APA -- Advanced Price Action

Pure price action: structure, key levels, liquidity, confirmation. Indicators are context at most, never the reason. Trading is kept simple: a level, a sweep, a confirmation, a refined entry, a plan.

## The story every APA trade must have (all five, in order)
1. **Bias (H4, then H1).** Higher highs/lows = buys, lower highs/lows = sells. A break of structure (BOS) in the trend direction confirms it; the FIRST break against the trend is a change of character (CHoCH) -- the start of a possible reversal. Know whether you trade WITH the external (big) structure or a pullback inside it (internal structure): a counter-trend trade takes profit at the opposite H4 zone, not the moon.
2. **A key level from one of the 7 models**, the one CLOSEST to the latest BOS, and still FRESH (unmitigated -- price hasn't returned to it). Draw it on candle BODIES (wicks ignored); a line chart makes A, V and QM levels obvious.
3. **Liquidity.** Equal highs/lows, swing points, a leg of price just before the level. "If you can't see the liquidity, you are the liquidity." The level is best when liquidity sits right in front of it. Equal highs/lows still un-swept INSIDE the zone = more liquidity to come -- wait for it.
4. **Confirmation on M15/M5** once price taps the level: a CHoCH (break of the last M5/M15 swing), a CLOSE beyond it, or a clear rejection candle (pin bar, engulfing).
5. **Refine and plan.** Entering on the CHoCH candle itself usually means a wide stop and only ~1:2. Refine: the order block (last opposite candle) that caused the CHoCH on M15/M5 -- skip ones already mitigated, take the first fresh one -- and put the LIMIT a few pips inside it. Stop a few pips beyond the key level / the refined swing. TP1 at 1:3 or the first obvious liquidity (bank 50%, stop to breakeven), the rest to the higher-timeframe liquidity (1:8 to 1:17 are normal for refined entries).

## The 7 entry models

**1. OCL buy (open-close level).** The line where one bullish candle CLOSES and the next bullish candle OPENS (bodies only) on H4/H1, in an uptrend, nearest the last bullish BOS, with sell-side liquidity just below. On M5 it shows up as a rally-base-rally zone / order block. Price pulls back into it, sweeps the liquidity, M15/M5 bullish CHoCH -> refined BUY LIMIT in the M15/M5 order block. SL below the OCL / refined swing low. TP: buy-side liquidity / the H4 high.

**2. OCL sell.** The open-close line between two bearish candles after a bearish BOS. Price pulls up into it; on M5 a rejection candle = first entry; a candle CLOSE back below the zone / a bearish CHoCH = second, refined entry. SL above the OCL. TP: the H4 lows.

**3. Resistance "A" formation (sell).** In a bearish market or at an H4 supply zone: price pushes up, then breaks a low (CHoCH down). The highest candle BODY before that break is the tip of the "A" (switch to a line chart to see it). Liquidity forms below; price takes it, comes back up to the A level -> M5 rejection/CHoCH -> SELL. SL a few pips above the A. Stronger when the A sits inside an order block or the H4 supply, with a fair value gap below. TP: 1:3 then the H4 lows.

**4. Support "V" formation (buy).** Mirror of the A: after a bullish BOS, the lowest candle BODY of the pullback is the bottom of the V. Wait for a SECOND BOS -- that creates the liquidity below. Price sweeps that liquidity and taps the V -> M5 confirmation -> BUY. SL a few pips below the V. Early buyers who enter before the sweep get stopped out -- don't be one. Counter-trend? Target the opposite H4 supply.

**5. SBR -- support becomes resistance (sell).** A level that held price up is broken and price trades below it. Wait for the retest from below; on M5 wait for a CLOSE below the last M5 low (the CHoCH) -> SELL. SL above the level. TP: the H1/H4 swing lows. A direct entry at the level without that close is a gamble -- there may be supply just above that price runs to first.

**6. RBS -- resistance becomes support (buy).** Mirror: resistance broken to the upside, retest from above, M5 bullish CHoCH (a close above the last M5 high) -> BUY. SL below the level. TP: the higher-timeframe highs.

**7. QM -- Quasimodo (early reversal).** QM sell: an uptrend, then the FIRST break of a swing low (CHoCH). Price builds liquidity, takes it, and returns to the LEFT SHOULDER -- the high before the high that failed -- drawn as a horizontal level. M5 confirmation -> SELL; SL above the shoulder. QM buy: the mirror at the end of a downtrend -- first break of a swing high, back to the left-shoulder low -> BUY; SL below it. Catches reversals at the extreme (1:10+ is common) -- bank 50% at 1:3.

## Running it with your tools -- what to do at each stage
The setup unfolds over hours; your job is to have the right order or alert waiting at each stage, never to forget a level.
- **The moment you identify a key level** (OCL, A, V, SBR/RBS, QM shoulder, supply/demand) that price hasn't reached: \`mark_level\` it (with the model name, direction and the liquidity you expect swept) AND, if the refined entry is clear, place the order: \`BUY_LIMIT\` below price for buys, \`SELL_LIMIT\` above price for sells, at the level with the stop beyond it. A level you found and didn't mark or order is a trade you will miss.
- **When the setup needs something to happen first** (the liquidity sweep, then the CHoCH, then the retest) -- \`setup_create\`: steps in order (e.g. "price below the equal lows", then "price back above the OCL"), \`cancelIf\` for the move that kills it (a close beyond the level), and the order to place when the last step happens.
- **When the decision depends on a candle close or a session** (H1/H4 close, M5 close below the CHoCH low, London open) -- \`set_reminder\` for that time, with the idea and the level as the reason, on the pair. It comes back to you as its own scan.
- **When the level is hit and confirmed now** -- enter at market on the rejection/CHoCH, and a second refined limit in the order block if the stop allows (lot limits still apply).
- **Pending order sitting 10+ minutes, or the story changed** (the level got mitigated without you, structure broke the other way) -- recheck it: keep, move to the next fresh level, or cancel. Never two orders on the same idea.
- **Show it**: \`draw_setup\` with the strategy name and the numbered story (BOS, level, liquidity, sweep, CHoCH, entry, SL, TP).

## The pullback confirmation trade (the trader's own)
After the CHoCH confirms, price usually pulls back to the refined level before the real move. TRADE THAT PULLBACK -- it is the confirmation entry, with the tightest stop. As soon as it is in profit by a clear push (about 1R, or the first liquidity taken), move the stop to TRUE breakeven (\`set_breakeven\`) -- from there the trade is free and you let it run to the target. If price never pulls back, the setup ran without you; mark the next level instead of chasing.

## Management
- 50% off at 1:3 (or at the first liquidity), stop to breakeven, the rest to the higher-timeframe liquidity.
- The stop is the invalidation. No early fear-close -- price tests the level and leaves; that drawdown is normal.
- A trade that goes straight to profit after a refined entry is the signature of a valid setup; one that reverses at once usually means the level or the refinement was wrong -- note it for the lesson, don't widen anything.

## Mistakes that kill most traders
- Entering on the first CHoCH candle without refining -> wide stop -> stopped before the move.
- Buying before the liquidity below is swept (selling before the highs above are swept): the setup looks right and you are the liquidity.
- Forcing price: no level reached = no trade; analyse again and find the next level.
- Patience waiting for the level -- but decisive action once it is hit and confirmed.

## On synthetics (Boom/Crash/Volatility/Storm)
The same structure, levels and liquidity read applies; a spike is a liquidity sweep or an impulsive BOS. Respect the instrument's spike direction (Boom spikes up, Crash spikes down) -- prefer APA entries WITH the spike, and a refined limit at the level where the spike launches.
`;

/** Adds the skill to an account that doesn't have it; keeps its text current if it's already there. */
export function seedApaSkill(userId: string): Skill {
  const existing = listSkills(userId).find((s) => s.name === APA_SKILL_NAME);
  if (!existing) {
    return createSkill(userId, {
      name: APA_SKILL_NAME,
      description: "Advanced Price Action: OCL buy/sell, resistance A, support V, SBR, RBS, QM -- HTF level + liquidity sweep + M5/M15 CHoCH, refined order-block limit, SL beyond the level, 50% at 1:3, rest to HTF liquidity; when to mark levels, set reminders, place limits and setups; the pullback trade to breakeven.",
      content: APA_SKILL_CONTENT,
      source: "built-in",
    });
  }
  return existing.content === APA_SKILL_CONTENT ? existing : updateSkillContent(userId, existing.id, APA_SKILL_CONTENT);
}
