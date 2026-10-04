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

console.log("[4] Liquidity engineering: sell-side swept by a thrust candle, FMD, then a CHoCH up");
const { describeApaCoordination } = await import("../src/apa-structure.js");
const le: typeof bars = [];
const path = [110, 106, 108, 104, 107, 103, 106, 101.5, 105, 102, 109, 107, 112];
let tt = 0;
for (let i = 1; i < path.length; i++) for (let k = 0; k < 3; k++) {
  const o = path[i - 1] + ((path[i] - path[i - 1]) * k) / 3, c = path[i - 1] + ((path[i] - path[i - 1]) * (k + 1)) / 3;
  le.push({ t: tt++, o, c, h: Math.max(o, c) + 0.2, l: Math.min(o, c) - 0.2 });
}
// A thrust candle: wick under the 101.5 low, close back above it.
le.splice(28, 0, { t: 28.5, o: 102.2, h: 102.6, l: 100.4, c: 102.3 });
le.forEach((b, i) => (b.t = i));
const leRead = readApa(le)!;
assert.ok(leRead.engineering, "engineering found");
assert.equal(leRead.engineering!.side, "bullish");
assert.ok(leRead.engineering!.fmd <= 100.4 + 1e-9, "FMD = the sweep's extreme");
assert.match(describeApa("M15", le)!, /LIQUIDITY ENGINEERING bullish: .* FMD 100\.4/);
console.log("   ✓");

console.log("[5] Coordination: two timeframes must agree, else NOT COORDINATED");
const up = Array.from({ length: 60 }, (_, i) => { const base = 100 + i * 0.5 + (i % 6 < 3 ? (i % 6) : 6 - (i % 6)) * 1.2; return { t: i, o: base, c: base + 0.3, h: base + 0.6, l: base - 0.4 }; });
const coord = describeApaCoordination([{ tf: "H4", bars: up }, { tf: "H1", bars: up }]);
assert.match(coord ?? "", /COORDINATION: (BULLISH|NOT COORDINATED)/);
console.log(`   ${coord}`);
console.log("   ✓");

console.log("[6] The VOL_10 case: BUY LIMIT 1046960, TP 1048045, price runs to 1048155 untouched");
const { limitsPastTarget } = await import("../src/safety-alerts.js");
resetSafetyState();
const vol = { ticket: "1248569690", symbol: "VOL_10", type: "buy_limit" as const, lots: 0.01, price: 1046960, sl: 1046650, tp: 1048045 };
let px = 1047400;
const chk = (now: number) => staleLimitChecks("v", [vol], () => px, () => "M15 bullish OB", now);
assert.equal(chk(T).length, 1, "already 40% of the way to its TP -> reminder at once");
px = 1047900;
assert.equal(chk(T + 2 * MIN).length, 0, "not twice in 5 minutes");
assert.match(chk(T + 6 * MIN)[0].text, /\d+% of the way to its own TP 1048045/);
px = 1048155;
assert.deepEqual(limitsPastTarget([vol], () => px).map((o) => o.ticket), ["1248569690"], "TP reached unfilled -> cancel");
assert.deepEqual(limitsPastTarget([vol], () => 1047000), []);
console.log("   ✓");

console.log("=== step200: ALL ASSERTIONS PASSED ===");
process.exit(0);
