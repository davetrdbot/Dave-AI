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

console.log("[2] Fixed pips are measured from the ORDER's entry, not the live price");
// A BUY_LIMIT 50 pips under price. Old code: 30 pips under the LIVE price = 1.0970, which sits ABOVE
// the 1.0950 entry -- "stop on the wrong side", trade thrown away.
lv = resolveTradeLevels({ action: "BUY_LIMIT", decision: { entry: 1.095, target: 1.1020 }, risk: fixedSl, price, pip, minRiskReward: 2 });
assert.equal(lv.sl, 1.092, "30 pips under the 1.0950 entry");
assert.equal(lv.entry, 1.095);
assert.equal(lv.problem, undefined, "a perfectly good limit is no longer refused");
assert.equal(lv.ratio, 2.33);

console.log("[3] A market order is measured from where it really fills (ask for a buy), not the model's typed entry");
const auto = { slMode: "auto" as const, tpMode: "auto" as const };
// The model typed entry 1.0980 (stale), stop 1.0960, target 1.1020: 2:1 on paper. Real fill 1.1002:
// risk 42 pips, reward 18 pips = 0.43:1.
lv = resolveTradeLevels({ action: "BUY", decision: { entry: 1.098, sl: 1.096, tp: 1.102 }, risk: auto, price, pip, minRiskReward: 2 });
assert.equal(lv.entry, 1.1002, "the ask, the price a buy fills at");
assert.ok(lv.problem && /0\.43:1/.test(lv.problem), `refused on the REAL ratio: ${lv.problem}`);
assert.equal(marketPrice("SELL", price), 1.1, "a sell fills at the bid");
assert.equal(exitPrice("BUY", price), 1.1, "a buy's stop is triggered by the bid");

console.log("[4] TP off no longer switches the floor off -- the target is checked, nothing is placed");
const tpOff = { slMode: "auto" as const, tpMode: "off" as const };
lv = resolveTradeLevels({ action: "SELL", decision: { sl: 1.105 }, risk: tpOff, price, pip, minRiskReward: 2 });
assert.match(lv.problem!, /no target was named/, "a trade with a stop and no target can't dodge the floor");
lv = resolveTradeLevels({ action: "SELL", decision: { sl: 1.105, target: 1.097 }, risk: tpOff, price, pip, minRiskReward: 2 });
assert.equal(lv.tp, undefined, "nothing placed at the broker");
assert.equal(lv.tpSource, "planned");
assert.match(lv.problem!, /0\.60:1, below your configured minimum of 2:1/);
lv = resolveTradeLevels({ action: "SELL", decision: { sl: 1.102, target: 1.094 }, risk: tpOff, price, pip, minRiskReward: 2 });
assert.equal(lv.problem, undefined);
assert.equal(lv.ratio, 3);
// A tp given under TP off is placed, as it always was ("off" = no fixed rule).
lv = resolveTradeLevels({ action: "SELL", decision: { sl: 1.102, tp: 1.094 }, risk: tpOff, price, pip, minRiskReward: 2 });
assert.equal(lv.tp, 1.094);

console.log("[5] With a fixed stop, the refusal says exactly what CAN change");
lv = resolveTradeLevels({ action: "BUY", decision: { target: 1.1030 }, risk: fixedSl, price, pip, minRiskReward: 2 });
assert.match(lv.problem!, /Your stop is FIXED at 30 pips \(1\.0972\) -- only the entry \(use a pending order\) or the target can change: the target must be at least 0\.0060 away from the entry/);

console.log("[6] SL off never strips the model's stop (off = no fixed rule, never 'no stop')");
lv = resolveTradeLevels({ action: "BUY", decision: { sl: 1.098, tp: 1.106 }, risk: { slMode: "off", tpMode: "off" }, price, pip, minRiskReward: 2 });
assert.equal(lv.sl, 1.098);
assert.equal(lv.slSource, "model");

console.log("[7] A fixed stop on an instrument whose pip size is unknown is refused outright, never guessed");
lv = resolveTradeLevels({ action: "BUY", decision: { target: 2 }, risk: fixedSl, price, pip: undefined, minRiskReward: 2 });
assert.ok(lv.fatal && /pip size/.test(lv.problem!));

console.log("\n=== step187 trade levels: ALL ASSERTIONS PASSED ===");
