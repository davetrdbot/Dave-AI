import assert from "node:assert/strict";
import { resolveTradeLevels, marketPrice, exitPrice } from "../src/trade-levels.js";

// EURUSD-style prices: pip 0.0001. The trader's real settings: SL FIXED 30 pips, TP off, floor 2:1.
const pip = 0.0001;
const price = { bid: 1.1, ask: 1.1002 };
const fixedSl = { slMode: "on" as const, slValue: 30, tpMode: "off" as const };

console.log("[1] A fixed stop is the trader's rule -- the model's own stop no longer replaces it");
let lv = resolveTradeLevels({ action: "BUY", decision: { sl: 1.0990, target: 1.1080 }, risk: fixedSl, price, pip, minRiskReward: 2 });
assert.equal(lv.slSource, "fixed");
assert.equal(lv.sl, 1.0972, "30 pips under the real fill (ask 1.1002), not the model's 1.0990");
assert.equal(lv.problem, undefined);
assert.equal(lv.tp, 1.1062, "exact 1:2 -- 30 pips risked, 60 pips target");

console.log("[2] Fixed pips are measured from the ORDER's entry, not the live price");
// A BUY_LIMIT 50 pips under price. Old code: 30 pips under the LIVE price = 1.0970, which sits ABOVE
// the 1.0950 entry -- "stop on the wrong side", trade thrown away.
lv = resolveTradeLevels({ action: "BUY_LIMIT", decision: { entry: 1.095, target: 1.1020 }, risk: fixedSl, price, pip, minRiskReward: 2 });
assert.equal(lv.sl, 1.092, "30 pips under the 1.0950 entry");
assert.equal(lv.entry, 1.095);
assert.equal(lv.problem, undefined, "a perfectly good limit is no longer refused");
assert.equal(lv.tp, 1.101, "exact 1:2 from the limit's own entry");
assert.equal(lv.ratio, 2);

console.log("[3] Exact R:R is measured from where a market order really fills (ask for a buy)");
const auto = { slMode: "auto" as const, tpMode: "auto" as const };
// The model typed a stale entry 1.0980 and tp 1.1020. Real fill 1.1002, stop 1.0960: 42 pips risked,
// so the target is exactly 84 pips above the fill -- the model's tp is replaced.
lv = resolveTradeLevels({ action: "BUY", decision: { entry: 1.098, sl: 1.096, tp: 1.102 }, risk: auto, price, pip, minRiskReward: 2 });
assert.equal(lv.entry, 1.1002, "the ask, the price a buy fills at");
assert.equal(lv.tp, 1.1086);
assert.equal(lv.tpSource, "rr");
assert.equal(lv.problem, undefined);
assert.equal(marketPrice("SELL", price), 1.1, "a sell fills at the bid");
assert.equal(exitPrice("BUY", price), 1.1, "a buy's stop is triggered by the bid");

console.log("[4] The trader's example: buy 100, stop 98, R:R 3.5 -> take profit exactly 107");
lv = resolveTradeLevels({ action: "BUY_LIMIT", decision: { entry: 100, sl: 98, tp: 104 }, risk: auto, price: { bid: 101, ask: 101 }, pip: 0.01, minRiskReward: 3.5 });
assert.equal(lv.tp, 107);
assert.equal(lv.ratio, 3.5);
// Sell side, TP off (no fixed rule): the exact target is still placed.
const tpOff = { slMode: "auto" as const, tpMode: "off" as const };
lv = resolveTradeLevels({ action: "SELL", decision: { sl: 1.105 }, risk: tpOff, price, pip, minRiskReward: 2 });
assert.equal(lv.tp, 1.09, "bid 1.1000, 50 pips risked, 100 pips target");
assert.equal(lv.problem, undefined);

console.log("[5] A fixed-pip take profit still wins over R:R");
lv = resolveTradeLevels({ action: "BUY", decision: { sl: 1.098 }, risk: { slMode: "auto", tpMode: "on", tpValue: 10 }, price, pip, minRiskReward: 2 });
assert.equal(lv.tp, 1.1012);
assert.equal(lv.tpSource, "fixed");
assert.match(lv.problem!, /below your configured minimum/, "and the ratio floor still guards it");

console.log("[6] A stop on the wrong side is still refused; SL off never strips the model's stop");
lv = resolveTradeLevels({ action: "BUY", decision: { sl: 1.101 }, risk: auto, price, pip, minRiskReward: 2 });
assert.match(lv.problem!, /wrong side/);
lv = resolveTradeLevels({ action: "BUY", decision: { sl: 1.098, tp: 1.106 }, risk: { slMode: "off", tpMode: "off" }, price, pip, minRiskReward: 2 });
assert.equal(lv.sl, 1.098);
assert.equal(lv.slSource, "model");
assert.equal(lv.tp, 1.1046, "22 pips risked from the 1.1002 fill, 44 pips target");

console.log("[7] A fixed stop on an instrument whose pip size is unknown is refused outright, never guessed");
lv = resolveTradeLevels({ action: "BUY", decision: { target: 2 }, risk: fixedSl, price, pip: undefined, minRiskReward: 2 });
assert.ok(lv.fatal && /pip size/.test(lv.problem!));

console.log("\n=== step187 trade levels: ALL ASSERTIONS PASSED ===");
