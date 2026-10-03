import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.DAVE_DATA_ROOT = mkdtempSync(join(tmpdir(), "fit-"));

/** The merged get_all_analysis suite reaches the prompt with EVERY timeframe -- never cut mid-way. */
const { fitSuite, SUITE_PROMPT_BUDGET } = await import("../src/autonomous-tick.js");

const big = (tf: string) => ({
  market_structure: { tf, structure: "x".repeat(4000) },
  liquidity: "l".repeat(3000),
  price: { bid: 1 },
  backtest: "b".repeat(20000),
  gann: "g".repeat(10000),
  ichimoku: "i".repeat(5000),
});
const tfs = ["D1", "H4", "H1", "M15", "M5", "M3", "M1"];
const suite = Object.fromEntries(tfs.map((tf) => [tf, big(tf)]));
assert.ok(JSON.stringify(suite).length > SUITE_PROMPT_BUDGET, "this suite is bigger than one prompt");
const out = fitSuite(suite);
assert.ok(out.length <= SUITE_PROMPT_BUDGET, `fits (${out.length})`);
const parsed = JSON.parse(out) as Record<string, Record<string, unknown>>; // valid JSON: not cut mid-way
assert.deepEqual(Object.keys(parsed), tfs, "every timeframe is there, M1 included");
for (const tf of tfs) {
  assert.ok(parsed[tf].market_structure && parsed[tf].liquidity && parsed[tf].price, `${tf} keeps structure, liquidity and price`);
  assert.ok(!("backtest" in parsed[tf]), `${tf}: the least-used extras go first`);
  assert.ok(Array.isArray(parsed[tf]._left_out_for_space), "and what was left out is named");
}
const small = { H1: { price: { bid: 1 } } };
assert.equal(fitSuite(small), JSON.stringify(small), "a suite that fits goes in untouched");
console.log("=== ALL ASSERTIONS PASSED ===");
process.exit(0);
