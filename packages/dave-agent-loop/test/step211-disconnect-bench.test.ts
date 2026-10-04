import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.DAVE_DATA_ROOT = mkdtempSync(join(tmpdir(), "dave-disc-"));
const { recordNoData, clearBenchesFromDisconnect, benchSymbols, clearNoDataBenches, isSymbolUnavailable, liftBrokerBenchesExcept } = await import("../src/symbol-availability.js");
const src = (await import("node:fs")).readFileSync(new URL("../src/autonomous-tick.ts", import.meta.url), "utf8");

/** MT5 not logged in made pairs look "not on this broker" and they got benched for 6 h. */
const U = "disc-user";
recordNoData(U, "VOL_10", "\"VOL_10\" isn't on this broker (not in its symbol list)");
const b = recordNoData(U, "VOL_10", "\"VOL_10\" isn't on this broker (not in its symbol list)");
assert.equal(b.benched, true);
benchSymbols(U, ["XPTUSD"], "not on this broker list from Market Watch", 6);
assert.deepEqual(clearBenchesFromDisconnect(U), ["VOL_10"], "only benches set because pairs looked missing are lifted");
assert.deepEqual(clearBenchesFromDisconnect(U), [], "nothing left to lift");
assert.match(src, /mt5_not_connected\|warming_up/, "a disconnected or loading MT5 is never counted against a pair");
// every pair benched for "no data" would stop the scan: those benches are lifted, the broker list stays
recordNoData(U, "VOL_20", "timeout"); recordNoData(U, "VOL_20", "timeout");
assert.ok(isSymbolUnavailable(U, "VOL_20"));
assert.deepEqual(clearNoDataBenches(U), ["VOL_20"]);
assert.ok(isSymbolUnavailable(U, "XPTUSD"), "the broker's own missing-pairs bench stays");
assert.match(src, /benches lifted, scanning again next cycle/);
// Market Watch said "not on this broker" while MT5 was disconnected; a real answer later lifts the pairs it has
benchSymbols(U, ["STORM_500", "XRPUSD"], "not offered by this broker (MT5 couldn't add it to Market Watch)", 24);
assert.deepEqual(liftBrokerBenchesExcept(U, ["XRPUSD"]), ["STORM_500"]);
assert.ok(isSymbolUnavailable(U, "XRPUSD") && !isSymbolUnavailable(U, "STORM_500"));
console.log("=== step211: ALL ASSERTIONS PASSED ===");
process.exit(0);
