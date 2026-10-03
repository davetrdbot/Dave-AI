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
assert.deepEqual(Object.keys(parsed).filter((k) => k !== "_same_on_every_timeframe"), tfs, "every timeframe is there, M1 included");
for (const tf of tfs) {
  assert.ok(parsed[tf].market_structure && parsed[tf].liquidity && parsed[tf].price, `${tf} keeps structure, liquidity and price`);
  assert.ok(!("backtest" in parsed[tf]), `${tf}: identical extras are not repeated per timeframe`);
}
// Data identical on every timeframe (news, macro) goes in once, not seven times.
const withShared = Object.fromEntries(tfs.map((tf) => [tf, { ...big(tf), news: { events: "n".repeat(15000) }, weird_new_key: "w".repeat(30000) }]));
const out2 = fitSuite(withShared);
assert.ok(out2.length <= SUITE_PROMPT_BUDGET, `fits with shared data (${out2.length})`);
const p2 = JSON.parse(out2) as Record<string, Record<string, unknown>>;
assert.ok(p2._same_on_every_timeframe && "news" in p2._same_on_every_timeframe, "news sent once");
assert.equal(out2.split('"nnnnnnnnnn').length - 1, 1, "only one copy of the news");
for (const tf of tfs) assert.ok(p2[tf].market_structure && p2[tf].price && !("news" in p2[tf]), `${tf} keeps its own core, no news copy`);

const small = { H1: { price: { bid: 1 } } };
assert.equal(fitSuite(small), JSON.stringify(small), "a suite that fits goes in untouched");
console.log("=== ALL ASSERTIONS PASSED ===");
process.exit(0);
