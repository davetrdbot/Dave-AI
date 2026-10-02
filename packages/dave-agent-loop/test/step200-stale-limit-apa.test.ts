import assert from "node:assert/strict";

/** The trader's STALE LIMIT REMINDER spec, and the APA structure read from candles. */
const { staleLimitChecks, resetSafetyState } = await import("../src/safety-alerts.js");
const { readApa, describeApa } = await import("../src/apa-structure.js");

const MIN = 60_000;
const T = Date.parse("2026-10-02T10:00:00Z");
resetSafetyState();
const order = { ticket: "555", symbol: "VOL_75", type: "buy_limit" as const, lots: 0.02, price: 100 };
let price = 101;
const run = (now: number) => staleLimitChecks("u", [order], () => price, () => "bullish AOL at 100", now);

console.log("[1] First sight sets the baseline; price running away -> reminder with fresh numbers, every 5 min");
assert.equal(run(T).length, 0);
price = 103;
let r = run(T + 1 * MIN);
assert.equal(r.length, 1);
assert.match(r[0].text, /VOL_75 BUY LIMIT at 100 \(ticket 555\) has been pending for 1 minutes/);
assert.match(r[0].text, /Price is now 103, 3 points past the limit level\./);
assert.match(r[0].text, /Entry reason: bullish AOL at 100/);
assert.match(r[0].text, /Should I place a BUY at market instead\?/);
price = 104;
assert.equal(run(T + 3 * MIN).length, 0, "not again within 5 minutes");
r = run(T + 6 * MIN);
assert.match(r[0].text, /4 points past the limit level \(was 3 points at the last reminder\)/);
console.log("   ✓");

console.log("[2] Price touches the level -> reminders stop for good; gone order -> forgotten");
price = 100;
assert.equal(run(T + 12 * MIN).length, 0);
price = 110;
assert.equal(run(T + 20 * MIN).length, 0, "touched once = never stale");
assert.equal(staleLimitChecks("u", [], () => price, () => "", T + 30 * MIN).length, 0);
console.log("   ✓");

console.log("[3] APA read: an uptrend, then a close through its last higher low = shift with invalidation");
const pts = [100, 104, 102, 107, 104, 110, 107, 113, 110, 116, 105, 103, 101];
const bars: { t: number; o: number; h: number; l: number; c: number }[] = [];
let t = 0;
for (let i = 1; i < pts.length; i++) {
  for (let k = 0; k < 3; k++) {
    const o = pts[i - 1] + ((pts[i] - pts[i - 1]) * k) / 3;
    const c = pts[i - 1] + ((pts[i] - pts[i - 1]) * (k + 1)) / 3;
    bars.push({ t: t++, o, c, h: Math.max(o, c) + 0.2, l: Math.min(o, c) - 0.2 });
  }
}
const read = readApa(bars)!;
assert.ok(read.lastBos, "a break of structure found");
assert.ok(read.validation !== undefined && read.invalidation !== undefined, "validation + invalidation points");
const line = describeApa("H1", bars)!;
assert.match(line, /^H1: trend/);
assert.match(line, /VALIDATION .*INVALIDATION/);
console.log(`   ${line}`);
console.log("   ✓");

console.log("=== step200: ALL ASSERTIONS PASSED ===");
process.exit(0);
