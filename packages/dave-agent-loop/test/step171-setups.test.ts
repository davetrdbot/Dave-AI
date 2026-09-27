import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DAVE_DATA_ROOT = mkdtempSync(join(tmpdir(), "dave-setups-"));

/**
 * The trader: "if market go this way and come this way place this trade; if the market goes the
 * way then come back don't place -- like a python trading terminal given to the bot".
 */
const { advanceSetup, createSetup, listSetups, TRADING_TOOLS } = await import("@dave/trading");
const { runSetupSweep } = await import("../src/setup-sweep.js");

console.log("=== Step 171: Setups -- if price does this, then that, place ===\n");
const t0 = Date.parse("2026-09-27T10:00:00Z");
const userId = "trader";

console.log("[1] Validation");
assert.throws(() => createSetup(userId, { symbol: "XAUUSD", reason: "x", steps: [], order: { type: "buy" } }, t0), /at least one step/);
assert.throws(() => createSetup(userId, { symbol: "XAUUSD", reason: "x", steps: [{ op: "above", price: 1 }], order: { type: "buy_limit" } }, t0), /needs order.price/);
assert.throws(() => createSetup(userId, { symbol: "XAUUSD", reason: "x", steps: [{ op: "up", price: 1 }], order: { type: "buy" } }, t0), /step/);
console.log("   ✓\n");

console.log("[2] Steps happen in order, one per tick; cancelIf kills it");
const s = createSetup(userId, { symbol: "XAUUSD", reason: "sweep the high then buy the dip", steps: [{ op: "above", price: 2660 }, { op: "below", price: 2650 }], cancelIf: [{ op: "below", price: 2640 }], order: { type: "buy", lots: 0.02, sl: 2641, tp: 2672 } }, t0);
assert.equal(advanceSetup(s, 2645, t0).kind, "none", "below 2650 before the high was swept doesn't count");
assert.deepEqual(advanceSetup(s, 2661, t0), { kind: "progress", stage: 1 });
assert.equal(advanceSetup({ ...s, stage: 1 }, 2649, t0).kind, "place");
assert.equal(advanceSetup({ ...s, stage: 1 }, 2639, t0).kind, "cancel", "the wrong way first: don't place");
assert.equal(advanceSetup(s, 2655, t0 + 25 * 3600_000).kind, "expire");
console.log("   ✓\n");

console.log("[3] The sweep walks it against the live price and places the order");
const opens: { type: string; lots: number; sl?: number; tp?: number }[] = [];
const notes: string[] = [];
const executor = { openOrder: async (o: never) => (opens.push(o), { ticket: "T1" }) } as never;
let price = 2655;
const deps = { userId, executor, notify: async (t: string) => void notes.push(t), quote: async () => price };
await runSetupSweep(deps, t0 + 1000);
assert.equal(listSetups(userId)[0].stage, 0);
price = 2662;
await runSetupSweep(deps, t0 + 2000);
assert.equal(listSetups(userId)[0].stage, 1);
price = 2649;
await runSetupSweep(deps, t0 + 3000);
assert.equal(opens.length, 1);
assert.deepEqual([opens[0].type, opens[0].lots, opens[0].sl, opens[0].tp], ["buy", 0.02, 2641, 2672]);
const done = listSetups(userId, { includeFinished: true }).find((x) => x.id === s.id)!;
assert.equal(done.status, "placed");
assert.equal(done.ticket, "T1");
assert.equal(listSetups(userId).length, 0);
assert.ok(notes.some((n) => n.includes("triggered")));
console.log("   ✓\n");

console.log("[4] A setup cancelled by the wrong move never places");
createSetup(userId, { symbol: "XAUUSD", reason: "r", steps: [{ op: "above", price: 2700 }], cancelIf: [{ op: "below", price: 2600 }], order: { type: "sell" } }, t0);
price = 2590;
await runSetupSweep(deps, t0 + 4000);
assert.equal(opens.length, 1);
assert.equal(listSetups(userId).length, 0);
console.log("   ✓\n");

console.log("[5] The tools");
const names = TRADING_TOOLS.map((t) => t.name);
for (const n of ["setup_create", "setup_list", "setup_cancel"]) assert.ok(names.includes(n), n);
const create = TRADING_TOOLS.find((t) => t.name === "setup_create")!;
const out = (await create.execute({ symbol: "EURUSD", reason: "r", steps: [{ op: "above", price: 1.1 }], order: { type: "buy" } }, { userId } as never)) as { created: string; plan: string };
assert.match(out.plan, /EURUSD: above 1.1, then BUY/);
console.log("   ✓\n");
console.log("All Step 171 checks passed.");
