import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DAVE_DATA_ROOT = mkdtempSync(join(tmpdir(), "dave-mw-sync-"));

/**
 * The trader: "the market watch -- all those group pairs should be automatically added". Every pair
 * from every group goes to the EA as one market_watch command; a fresh account gets its groups
 * seeded first, so there is always something to send.
 */
const { allGroupSymbols, createMarketWatchSync } = await import("../src/market-watch-sync.js");
const { upsertGroup, listGroups } = await import("@dave/trading");
const { peekQueue } = await import("@dave/ea-bridge");

console.log("=== Step 164: every pair group's pairs go into MT5's Market Watch ===\n");

console.log("[1] A fresh account: groups are seeded, and every group's pairs are in the list");
const syms = allGroupSymbols("fresh");
assert.ok(listGroups("fresh").length >= 7, "default groups seeded");
for (const s of ["VOL_80", "EURUSD", "BTCUSD", "XAUUSD", "US30", "USOIL", "AAPL"]) assert.ok(syms.includes(s), s);
assert.equal(new Set(syms).size, syms.length, "no duplicates");
console.log(`   ${syms.length} pairs ✓\n`);

console.log("[2] One market_watch command with all of them; not re-sent unless something changed");
const sync = createMarketWatchSync("fresh");
assert.equal(sync.sync(true), true);
let q = peekQueue("fresh").filter((c) => c.action === "market_watch");
assert.equal(q.length, 1);
const cmd = q[0] as { id: string; symbols: string };
assert.deepEqual(cmd.symbols.split(","), syms);
assert.equal(sync.sync(), false, "unchanged -> nothing sent");
console.log("   ✓\n");

console.log("[3] A group edit is picked up on the next check; a new pair is added, duplicates merged");
upsertGroup("fresh", { id: "mine", name: "Mine", symbols: ["gbpusd", "NEWPAIR ", "EURUSD"] });
assert.equal(sync.sync(), true);
q = peekQueue("fresh").filter((c) => c.action === "market_watch");
const latest = (q.at(-1) as { symbols: string }).symbols.split(",");
assert.ok(latest.includes("NEWPAIR"));
assert.equal(latest.filter((s) => s === "EURUSD").length, 1);
console.log("   ✓\n");

console.log("[4] The EA's answer is recognised as ours and reported; anything else is ignored");
assert.equal(sync.describeResult({ commandId: cmd.id, status: "ok", message: "80 of 84 pairs in Market Watch" }), "80 of 84 pairs in Market Watch");
assert.equal(sync.describeResult({ commandId: cmd.id, status: "ok" }), undefined, "only once");
assert.equal(sync.describeResult({ commandId: "other", status: "ok" }), undefined);
console.log("   ✓\n");

console.log("=== ALL ASSERTIONS PASSED ===");
process.exit(0);
