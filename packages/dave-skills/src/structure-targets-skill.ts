import { createSkill, listSkills, updateSkillContent, type Skill } from "./skill-store.js";

/**
 * The trader's own targets-and-scalping strategy, shipped with Dave so every account has it
 * (activate it from Trading Mode -> Trading Skills, or the app). Written from the trader's words:
 * "the TP is too far from the entry... target the first TP at the previous side; the second just
 * above it; the third 150 pips above the second... the same for a sell... and the pullback entry
 * is a scalp: at twenty dollars you close, if it returns to the entry you go again, until it reaches
 * the limit, then you close it finally."
 */
export const STRUCTURE_TARGETS_SKILL_NAME = "Structure targets + $20 pullback scalps";

export const STRUCTURE_TARGETS_SKILL_CONTENT = `# Structure targets + $20 pullback scalps

This skill decides WHERE the stop loss and the take profits go, and how the pullback scalp is run. Find the entry with your own analysis as usual; every entry -- market, limit, stop, pullback scalp -- then takes its levels from here.

## Take profits: three, at structure -- never far from the entry
- **TP1 = the previous swing** in the trade's direction: for a BUY, the most recent swing HIGH above the entry; for a SELL, the most recent swing LOW below it. The nearest real level, not a distant one.
- **TP2 = just past that swing** -- a few pips beyond it (the liquidity resting above the high / below the low).
- **TP3 = 150 pips beyond TP2** -- for a buy, TP2 + 150 pips; for a sell, TP2 - 150 pips.
- Pip sizes: XAUUSD 0.1 (150 pips = 15.0 in price), XAGUSD 0.01, JPY pairs 0.01, other forex 0.0001. Indices, crypto and synthetics: use the pip size the analysis reports for the symbol.
- MT5 gives a position one TP, so three targets = three positions, the lots split between them (never below 0.01 each; with too little size, fewer parts -- TP1 first).

## Stop loss: at the structure that proves the idea wrong
- For a BUY, just below the swing low the move starts from; for a SELL, just above the swing high. Tight to structure, not a round distance -- and outside normal noise (not inside the ATR).
- TP1 must still pay the trader's risk:reward floor against this stop; if the previous swing is too close to pay it, the setup isn't worth taking at this entry.

## The pullback scalp -- banked $20 at a time
When you place a SELL LIMIT above price, you may also BUY the pullback into it (a BUY LIMIT below price -> SELL the pullback). The scalp is optional -- only with room on the account (see the trading rules). Run it like this (the bot does the mechanics for you once it's placed with the limit):
1. Open the scalp at market toward the limit, with its own stop.
2. When it is **+$20** in profit, close it -- profit banked.
3. If price comes **back to the scalp's entry**, open it again. Repeat: +$20, close; back to the entry, in again.
4. When price reaches **the limit order's price**, close the scalp for good -- from there the limit fills and the main trade takes over.
5. If price breaks the scalp's stop, the scalping is over; the limit still stands on its own.
`;

/** Adds the skill to an account that doesn't have it; keeps its text current if it's already there. */
export function seedStructureTargetsSkill(userId: string): Skill {
  const existing = listSkills(userId).find((s) => s.name === STRUCTURE_TARGETS_SKILL_NAME);
  if (!existing) {
    return createSkill(userId, {
      name: STRUCTURE_TARGETS_SKILL_NAME,
      description: "TP1 at the previous swing, TP2 just past it, TP3 150 pips beyond; SL at structure; pullback scalps banked $20 at a time until the limit.",
      content: STRUCTURE_TARGETS_SKILL_CONTENT,
      source: "built-in",
    });
  }
  return existing.content === STRUCTURE_TARGETS_SKILL_CONTENT ? existing : updateSkillContent(userId, existing.id, STRUCTURE_TARGETS_SKILL_CONTENT);
}
