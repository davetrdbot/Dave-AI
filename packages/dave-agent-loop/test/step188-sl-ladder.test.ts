import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DAVE_DATA_ROOT = mkdtempSync(join(tmpdir(), "dave-ladder-"));
const trading = await import("@dave/trading");
const { advanceMonitor } = await import("../src/trade-monitor-store.js");
const { buildMonitorAlert } = await import("../src/trade-monitor-sweep.js");

const U = "ladder";
console.log("[1] Five rows by default, starting at the deep-loss level");
assert.deepEqual(trading.getSlAlertLevels(U), [50, 60, 75, 89, 95]);

console.log("[2] The trader's own rows: 50 / 60 / 74, then add and delete");
assert.deepEqual(trading.setSlAlertLevels(U, [74, 50, 60, 60]), [50, 60, 74], "sorted, duplicates dropped");
assert.equal(trading.getDeepLossAlertPercent(U), 50, "the lowest row is the deep-loss level");
assert.deepEqual(trading.setSlAlertLevels(U, [40, 60, 74, 90]), [40, 60, 74, 90], "a row added, one changed");
assert.equal(trading.getDeepLossAlertPercent(U), 40);
assert.throws(() => trading.setSlAlertLevels(U, []), /at least one/);
assert.throws(() => trading.setSlAlertLevels(U, [3]), /between 5% and 99%/);
assert.throws(() => trading.setSlAlertLevels(U, Array.from({ length: 11 }, (_, i) => 10 + i * 5)), /At most 10/);
// Changing the deep-loss level elsewhere (Telegram /settings) moves the ladder's first row with it.
trading.setDeepLossAlertPercent(U, 30);
assert.deepEqual(trading.getSlAlertLevels(U), [30, 40, 60, 74, 90]);
trading.setSlAlertLevels(U, [50, 60, 74]);

console.log("[3] Each level fires once as the trade slides toward its stop");
const ladder = trading.getSlAlertLevels(U).map((l: number) => l / 100);
// BUY at 100, stop 90: 60% of the way = price 94.
const obs = (price: number) => ({ ticket: "1", symbol: "XAUUSD", direction: "buy" as const, openPrice: 100, sl: 90, tp: 120, currentPrice: price, pnl: price - 100, reason: "idea" });
const T = Date.now();
let r = advanceMonitor(undefined, obs(99), T, ladder[0], ladder);
r = advanceMonitor(r.monitor, obs(94.9), T + 60_000, ladder[0], ladder);
assert.ok(r.alerts.some((a) => a.kind === "deepLoss"), "50% = the deep-loss alert");
assert.ok(!r.alerts.some((a) => a.kind === "slLevel"));
r = advanceMonitor(r.monitor, obs(93.9), T + 120_000, ladder[0], ladder);
const sixty = r.alerts.find((a) => a.kind === "slLevel");
assert.equal(sixty?.level, 0.6);
assert.match(buildMonitorAlert(sixty!, T + 120_000), /60% OF THE WAY TO THE STOP/);
r = advanceMonitor(r.monitor, obs(93.5), T + 150_000, ladder[0], ladder);
assert.equal(r.alerts.filter((a) => a.kind === "slLevel").length, 0, "no repeat");
r = advanceMonitor(r.monitor, obs(92.5), T + 180_000, ladder[0], ladder);
assert.equal(r.alerts.find((a) => a.kind === "slLevel")?.level, 0.74);
assert.ok(!r.alerts.some((a) => a.kind === "slNear" || a.kind === "slCritical"), "the fixed 89/95 stages are replaced by the trader's rows");

console.log("[4] Back in profit re-arms the ladder for the next slide");
r = advanceMonitor(r.monitor, obs(101), T + 240_000, ladder[0], ladder);
r = advanceMonitor(r.monitor, obs(93.9), T + 300_000, ladder[0], ladder);
assert.ok(r.alerts.some((a) => a.kind === "slLevel" && a.level === 0.6));

console.log("[5] Rows at 85%+ read as 'nearly' / 'about to be' stopped out, with the real level");
const hi = [0.5, 0.88, 0.97];
let h = advanceMonitor(undefined, { ...obs(99), ticket: "2" }, T, 0.5, hi);
h = advanceMonitor(h.monitor, { ...obs(90.2), ticket: "2" }, T + 60_000, 0.5, hi);
const near = h.alerts.find((a) => a.kind === "slNear")!;
const crit = h.alerts.find((a) => a.kind === "slCritical")!;
assert.match(buildMonitorAlert(near, T), /travelled 88% of the way/);
assert.match(buildMonitorAlert(crit, T), /is 97% of the way to its stop/);

console.log("\n=== step188 SL warning ladder: ALL ASSERTIONS PASSED ===");
