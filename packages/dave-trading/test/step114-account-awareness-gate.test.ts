import assert from "node:assert/strict";
import { evaluateAccountAwareness } from "../src/index.js";

/**
 * Part 1 (Account awareness): real proof of the runtime gate behind prompts/trading.md's
 * pre-trade account-awareness instruction -- refuses when the user's own max-open-trades limit is
 * hit, refuses when free margin is critically low relative to balance (genuinely over-leveraged),
 * and otherwise gets out of the way.
 */

console.log("=== Real proof: evaluateAccountAwareness ===\n");

console.log("[1] Healthy account, no limits set -- ok...\n");
assert.deepEqual(evaluateAccountAwareness({ balance: 1000, freeMargin: 900, leverage: 500, openPositionsCount: 2 }, {}), { ok: true });
console.log("    confirmed ok");

console.log("\n[2] At the user's own max open trades -- blocked...\n");
const atLimit = evaluateAccountAwareness({ balance: 1000, freeMargin: 900, leverage: 500, openPositionsCount: 3 }, { maxOpenTrades: 3 });
assert.equal(atLimit.ok, false);
assert.match(atLimit.reason!, /max open trades/i);
console.log(`    confirmed blocked: ${atLimit.reason}`);

console.log("\n[3] Under the limit -- ok...\n");
assert.equal(evaluateAccountAwareness({ balance: 1000, freeMargin: 900, leverage: 500, openPositionsCount: 2 }, { maxOpenTrades: 3 }).ok, true);
console.log("    confirmed ok");

console.log("\n[4] Free margin critically low relative to balance -- genuinely over-leveraged, blocked even with no maxOpenTrades set...\n");
const overLeveraged = evaluateAccountAwareness({ balance: 1000, freeMargin: 50, leverage: 500, openPositionsCount: 1 }, {});
assert.equal(overLeveraged.ok, false);
assert.match(overLeveraged.reason!, /over-leveraged/i);
console.log(`    confirmed blocked: ${overLeveraged.reason}`);

console.log("\n[5] Free margin comfortably above the floor -- ok...\n");
assert.equal(evaluateAccountAwareness({ balance: 1000, freeMargin: 500, leverage: 500, openPositionsCount: 1 }, {}).ok, true);
console.log("    confirmed ok");

console.log("\n=== ALL ASSERTIONS PASSED ===");
