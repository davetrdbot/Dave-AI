import assert from "node:assert/strict";
import { derivePipSize } from "../src/pip-size.js";

/**
 * Real bug fixed (the trader: "find bugs in my code"). autonomous-tick.ts hardcoded
 * `const pip = 0.0001` for both the fixed-pip SL and the fixed-pip TP. Correct for 4-digit forex,
 * catastrophically wrong for this trader's actual watchlist -- synthetic indices whose real live
 * prices (straight from the same day's Railway logs) run to CRASH_200 at 615,490 and VOL_10 at
 * 1,407,421.
 *
 * These cases use those real price magnitudes, not invented ones.
 */

console.log("=== Real proof: pip size is derived per symbol, never assumed to be forex ===\n");

console.log("[1] A 4-digit forex pair still derives the classic 0.0001 -- no regression...\n");
const eurusd = derivePipSize({ bid: 1.08500, ask: 1.08520, spread_pips: 2.0 });
assert.ok(eurusd !== undefined, "a normal forex quote must derive cleanly");
assert.ok(Math.abs(eurusd - 0.0001) < 1e-9, `EURUSD must derive 0.0001, got ${eurusd}`);
console.log(`    confirmed: EURUSD -> ${eurusd} (exactly the value the old hardcode assumed)`);

console.log("\n[2] A real synthetic index derives a pip SIX ORDERS OF MAGNITUDE larger...\n");
// CRASH_200's real live price from the logs, with a spread the EA reports as 50 pips.
const crash200 = derivePipSize({ bid: 615490.0, ask: 615495.0, spread_pips: 50.0 });
assert.ok(crash200 !== undefined, "a synthetic index quote must derive cleanly");
assert.ok(Math.abs(crash200 - 0.1) < 1e-9, `CRASH_200 must derive 0.1, got ${crash200}`);
console.log(`    confirmed: CRASH_200 @ 615,490 -> pip ${crash200}, not 0.0001`);

console.log("\n[3] The real consequence the old hardcode caused, made concrete...\n");
const tpPips = 40;
const oldTp = 615490.0 + tpPips * 0.0001;
const newTp = 615490.0 + tpPips * crash200;
console.log(`    a ${tpPips}-pip TP under the OLD hardcoded pip: ${oldTp} -- that is ${(oldTp - 615490).toFixed(4)} away from entry`);
console.log(`    a ${tpPips}-pip TP with the REAL derived pip:   ${newTp} -- that is ${(newTp - 615490).toFixed(4)} away from entry`);
assert.ok(oldTp - 615490 < 0.01, "the old hardcode genuinely put the TP within a hundredth of a point of entry");
assert.ok(newTp - 615490 >= 4, "the derived pip genuinely puts the TP a real distance away");
console.log("    confirmed: the old maths closed the trade instantly for a spread-sized loss; the new maths does not");

console.log("\n[4] With no usable spread, it falls back to the EA's OWN digit rule rather than dropping the stop...\n");
// Real regression this covers, caught by step15: the first version returned undefined here, and
// the callers then skipped applying the user's fixed-pip SL/TP altogether -- producing a live
// position with NO STOP AT ALL. An absent stop is unbounded risk; a slightly mis-scaled one is
// bounded. The fallback is the EA's own ported rule (ea/DaveEA.mq5's g_aPip): a pip is ten points
// on a 3- or 5-decimal quote, one point otherwise.
assert.equal(derivePipSize({ bid: 1.085, ask: 1.0852 }), 0.0001, "a 4-decimal quote with no spread_pips must still yield the correct forex pip");
assert.equal(derivePipSize({ bid: 1.085, ask: 1.0852, spread_pips: 0 }), 0.0001, "a spread rounded to 0.00 pips must fall back, never divide by zero");
assert.equal(derivePipSize({ bid: 1.0852, ask: 1.0852, spread_pips: 2 }), 0.0001, "a zero spread must fall back rather than refuse");
const fiveDecimal = derivePipSize({ bid: 1.08523, ask: 1.08525 });
assert.ok(fiveDecimal !== undefined && Math.abs(fiveDecimal - 0.0001) < 1e-12, `a 5-decimal quote must yield ten points (0.0001), got ${fiveDecimal}`);
const integerQuote = derivePipSize({ bid: 196741, ask: 196743 });
assert.equal(integerQuote, 1, "an integer-priced synthetic index must yield one point per pip, not a forex pip");
console.log(`    confirmed: 4-decimal -> 0.0001, 5-decimal -> ${fiveDecimal}, integer synthetic -> ${integerQuote}`);

console.log("\n[4b] Genuinely unusable input still returns undefined -- never an invented number...\n");
assert.equal(derivePipSize(undefined), undefined, "no price data at all must refuse");
assert.equal(derivePipSize({}), undefined, "an empty price payload must refuse");
assert.equal(derivePipSize({ spread_pips: 2 }), undefined, "a spread with no price to scale against must refuse");
console.log("    confirmed: with no price at all it still refuses rather than guessing");

console.log("\n[5] A JPY-style 3-digit pair -- the other case the forex hardcode also got wrong...\n");
const usdjpy = derivePipSize({ bid: 157.250, ask: 157.270, spread_pips: 2.0 });
assert.ok(usdjpy !== undefined && Math.abs(usdjpy - 0.01) < 1e-9, `USDJPY must derive 0.01, got ${usdjpy}`);
console.log(`    confirmed: USDJPY -> ${usdjpy}, 100x the old hardcoded assumption`);

console.log("\n=== ALL ASSERTIONS PASSED ===");
process.exit(0);
