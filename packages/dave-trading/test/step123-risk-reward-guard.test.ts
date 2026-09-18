import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
process.env.DAVE_DATA_ROOT = mkdtempSync(pathJoin(tmpdir(), "dave-rr-"));
import type { OrderRequest } from "../src/order-types.js";
import { assessRiskReward, assessRiskRewardForUser, getMinRiskReward, setMinRiskReward, InvalidRiskRewardError, MIN_RISK_REWARD_RATIO } from "../src/risk-reward-guard.js";

/**
 * Real bug fixed, caught by the trader off his own live MT5 chart on a running VOL_80 position:
 *
 *   entry 196,741 | TP 200,500 = +$187.95 (3,759 points) | SL 192,800 = -$197.05 (3,941 points)
 *
 * The stop was WIDER than the target -- risking $197.05 to make $187.95, a 0.95:1 risk:reward
 * that needs a >51% win rate just to break even. A grep confirmed this codebase had NO
 * risk:reward validation of any kind, and no check that SL/TP even sit on the correct sides of
 * the entry. These cases use the real numbers from that trade.
 */

console.log("=== Real proof: a stop wider than its target is refused ===\n");

const VOL80_ENTRY = 196741;
const VOL80_TP = 200500;
const VOL80_SL = 192800;

function buy(sl?: number, tp?: number): OrderRequest {
  return { symbol: "VOL_80", type: "buy", lots: 0.05, sl, tp };
}
function sell(sl?: number, tp?: number): OrderRequest {
  return { symbol: "VOL_80", type: "sell", lots: 0.05, sl, tp };
}

console.log("[1] The trader's REAL trade is genuinely caught...\n");
const real = assessRiskReward(buy(VOL80_SL, VOL80_TP), VOL80_ENTRY);
console.log(`    risk ${real.riskDistance} points to gain ${real.rewardDistance} -> ${real.ratio?.toFixed(3)}:1`);
assert.equal(real.ok, false, "the trader's actual 0.95:1 trade must be refused");
assert.ok(real.ratio !== undefined && real.ratio < 1, `ratio must be computed and below 1, got ${real.ratio}`);
assert.match(real.reason!, /risk:reward is 0\.95:1/, "the refusal must state the real ratio back");
assert.equal(real.riskDistance, 3941, "risk distance must match the real chart exactly");
assert.equal(real.rewardDistance, 3759, "reward distance must match the real chart exactly");
console.log(`    confirmed refused: ${real.reason}`);

console.log("\n[2] Flipping it to a genuinely sane structure passes...\n");
const sane = assessRiskReward(buy(VOL80_ENTRY - 2000, VOL80_ENTRY + 4000), VOL80_ENTRY);
assert.equal(sane.ok, true, "a 2:1 trade must be allowed through");
assert.ok(Math.abs(sane.ratio! - 2) < 1e-9, `ratio must be exactly 2, got ${sane.ratio}`);
console.log(`    confirmed: 2.00:1 passes untouched`);

console.log("\n[3] Exactly 1:1 is the floor and is allowed -- the line is 'risks MORE than it gains'...\n");
const evenMoney = assessRiskReward(buy(VOL80_ENTRY - 3000, VOL80_ENTRY + 3000), VOL80_ENTRY);
assert.equal(evenMoney.ok, true, `exactly ${MIN_RISK_REWARD_RATIO}:1 must not be refused`);
console.log("    confirmed: 1.00:1 passes, anything below it does not");

console.log("\n[3b] A mathematically EXACT 1:1 trade is not rejected by floating-point noise...\n");
// Real values from step106's own EURUSD pending-order cases, which caught this before the guard
// shipped: these two distances compute as 0.015000000000000124 and 0.014999999999999902, a ratio
// of 0.9999999999999852 -- strictly below 1.0 in binary floating point, so a naive comparison
// refused a genuinely valid even-money trade.
const floatNoise = assessRiskReward({ symbol: "EURUSD", type: "sell_stop", lots: 0.1, sl: 1.11, tp: 1.08 }, 1.095);
assert.ok(floatNoise.ratio! < 1, "this case must genuinely land below 1.0 in floating point -- otherwise it is not testing the real hazard");
assert.equal(floatNoise.ok, true, "an exact 1:1 trade must NOT be refused over float representation noise");
console.log(`    confirmed: ratio ${floatNoise.ratio} is below 1.0 yet correctly allowed through`);

console.log("\n[4] A stop on the WRONG SIDE of entry is caught -- it would fill instantly for a certain loss...\n");
const slAbove = assessRiskReward(buy(VOL80_ENTRY + 500, VOL80_ENTRY + 4000), VOL80_ENTRY);
assert.equal(slAbove.ok, false, "a BUY whose stop sits above entry must be refused");
assert.match(slAbove.reason!, /wrong side/, "the refusal must name the real problem");
console.log(`    confirmed: ${slAbove.reason}`);

const sellSlBelow = assessRiskReward(sell(VOL80_ENTRY - 500, VOL80_ENTRY - 4000), VOL80_ENTRY);
assert.equal(sellSlBelow.ok, false, "a SELL whose stop sits below entry must be refused too");
console.log("    confirmed: the SELL mirror image is caught as well");

console.log("\n[5] A target on the wrong side is caught...\n");
const tpBelow = assessRiskReward(buy(VOL80_ENTRY - 2000, VOL80_ENTRY - 100), VOL80_ENTRY);
assert.equal(tpBelow.ok, false, "a BUY whose target sits below entry must be refused");
console.log(`    confirmed: ${tpBelow.reason}`);

console.log("\n[6] A trade the trader deliberately runs with no target is NOT blocked...\n");
assert.equal(assessRiskReward(buy(VOL80_ENTRY - 2000, undefined), VOL80_ENTRY).ok, true, "no TP means no ratio to judge -- must not refuse");
assert.equal(assessRiskReward(buy(undefined, VOL80_ENTRY + 4000), VOL80_ENTRY).ok, true, "no SL means no ratio to judge -- enforcing SL presence is risk-settings' job");
assert.equal(assessRiskReward(buy(undefined, undefined), VOL80_ENTRY).ok, true, "a bare order must pass through this guard untouched");
console.log("    confirmed: this guard judges the RATIO only -- it never silently becomes an 'SL is mandatory' rule");

console.log("\n[7] Nonsense input degrades safely rather than refusing a real trade...\n");
assert.equal(assessRiskReward(buy(VOL80_SL, VOL80_TP), 0).ok, true, "an unknown entry price must not block the trade here");
assert.equal(assessRiskReward(buy(VOL80_ENTRY, VOL80_TP), VOL80_ENTRY).ok, false, "a stop exactly AT entry is on the wrong side and must be refused");
console.log("    confirmed: unknown entry passes through; a zero-distance stop is still caught");

console.log("\n[8] The floor is the trader's to set -- 1:1 is only the DEFAULT...\n");
// Real feature (the trader, explicit: "the risk reward is possible make it settable"). A scalper
// may genuinely want 1:1 while a swing trader wants 1:2 -- imposing one is a strategy opinion.
const RR_USER = "user-rr-settable";
assert.equal(getMinRiskReward(RR_USER), MIN_RISK_REWARD_RATIO, "an unconfigured user must get the safe default");

const oneAndAHalf = buy(VOL80_ENTRY - 2000, VOL80_ENTRY + 3000); // exactly 1.5:1
assert.equal(assessRiskRewardForUser(RR_USER, oneAndAHalf, VOL80_ENTRY).ok, true, "1.5:1 must pass the default 1:1 floor");

setMinRiskReward(RR_USER, 2);
assert.equal(getMinRiskReward(RR_USER), 2, "the new floor must genuinely persist");
assert.equal(assessRiskRewardForUser(RR_USER, oneAndAHalf, VOL80_ENTRY).ok, false, "the SAME 1.5:1 trade must now be refused against a 2:1 floor");
console.log("    confirmed: 1.5:1 passes at the default, and is refused once the floor is raised to 2:1");

setMinRiskReward(RR_USER, 1);
assert.equal(assessRiskRewardForUser(RR_USER, oneAndAHalf, VOL80_ENTRY).ok, true, "lowering the floor back must genuinely take effect");
console.log("    confirmed: lowering it back to 1:1 lets the same trade through again");

for (const bad of [-5, 0, 1000, Number.NaN, Number.POSITIVE_INFINITY]) {
  assert.throws(() => setMinRiskReward(RR_USER, bad), InvalidRiskRewardError, `${bad} must be refused, typed`);
}
assert.equal(getMinRiskReward(RR_USER), 1, "a refused value must never have been written");
console.log("    confirmed: five invalid values all refused, and the stored floor is untouched");

console.log("\n=== ALL ASSERTIONS PASSED ===");
process.exit(0);
