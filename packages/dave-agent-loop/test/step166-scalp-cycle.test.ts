import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DAVE_DATA_ROOT = mkdtempSync(join(tmpdir(), "dave-scalp-cycle-"));

/**
 * The trader: "when it says sell limit, you buy; when price has reached twenty dollars, you close.
 * If it returns back to the entry, again... until it has reached the place for the limit order, then
 * you close it finally." Plus the structure-targets skill that ships with Dave.
 */
const { advanceScalpCycle, listScalpCycles, registerScalpCycle } = await import("@dave/trading");
const { runScalpCycleSweep } = await import("../src/scalp-cycle-sweep.js");
const { seedStructureTargetsSkill, listSkills, STRUCTURE_TARGETS_SKILL_NAME } = await import("@dave/skills");

console.log("=== Step 166: pullback scalp -- $20 at a time until the limit ===\n");
const t0 = Date.parse("2026-09-25T10:00:00Z");
const S = 1000;
// SELL LIMIT at 2360 above price; BUY scalp from 2350, SL 2345.
const base = { id: "c1", symbol: "XAUUSD", side: "buy" as const, entry: 2350, limitPrice: 2360, limitTicket: "L1", sl: 2345, lots: 0.1, ticket: "S1", phase: "open" as const, openedAt: t0, rounds: 0, banked: 0, createdAt: t0 };

console.log("[1] The rules, one by one");
let c = { ...base };
assert.equal(advanceScalpCycle(c, { position: { ticket: "S1", pnl: 12, currentPrice: 2351.2 }, limitPending: true }, t0 + 60 * S).kind, "none", "+$12: hold");
assert.deepEqual(advanceScalpCycle(c, { position: { ticket: "S1", pnl: 20.5, currentPrice: 2352 }, limitPending: true }, t0 + 90 * S), { kind: "take", ticket: "S1", pnl: 20.5 });
c = { ...base, phase: "wait" as const, ticket: undefined };
assert.equal(advanceScalpCycle(c, { limitPending: true, price: 2354 }, t0 + 120 * S).kind, "none", "price away from the entry: wait");
assert.equal(advanceScalpCycle(c, { limitPending: true, price: 2350.8 }, t0 + 150 * S).kind, "reenter", "back at the entry (within 10% of the way): in again");
assert.equal(advanceScalpCycle(c, { limitPending: true, price: 2344 }, t0 + 150 * S).kind, "finish", "stop broken: scalping over");
assert.equal(advanceScalpCycle(c, { limitPending: true, price: 2359.8 }, t0 + 150 * S).kind, "finish", "reached the limit");
assert.deepEqual(advanceScalpCycle({ ...base }, { position: { ticket: "S1", pnl: 5, currentPrice: 2359.9 }, limitPending: true }, t0 + 99 * S), { kind: "finish", reason: "price reached the limit at 2360", closeTicket: "S1" }, "at the limit: closed for good");
assert.equal(advanceScalpCycle({ ...base }, { limitPending: false }, t0 + 5 * S).kind, "none", "right after placing, the limit may not be reported yet");
assert.equal(advanceScalpCycle({ ...base }, { position: { ticket: "S1", pnl: 1 }, limitPending: false }, t0 + 60 * S).kind, "finish", "the limit filled: the main trade takes over");
assert.equal(advanceScalpCycle({ ...base }, { limitPending: true }, t0 + 10 * S).kind, "none", "a fresh scalp not yet in MT5's report isn't 'closed'");
console.log("   ✓\n");

console.log("[2] The whole loop through the sweep: $20, back to entry, $20 again, then the limit");
const userId = "trader";
registerScalpCycle(userId, { ...base });
const closes: string[] = [];
const opens: { type: string; lots: number; sl?: number; tp?: number }[] = [];
const said: string[] = [];
let positions: { ticket: string; symbol: string; type: "buy"; lots: number; openPrice: number; currentPrice?: number; pnl?: number }[] = [];
let price = 2350;
const deps = {
  userId,
  executor: {
    openOrder: async (o: never) => (opens.push(o), { ticket: `S${opens.length + 1}` }),
    modifyOrder: async () => {},
    closePosition: async (t: string) => (closes.push(t), { closedLots: 0.1, remainingLots: 0 }),
    deletePendingOrder: async () => {},
    listOpenPositions: async () => [],
    listPendingOrders: async () => [],
  },
  notify: async (t: string) => void said.push(t),
  eaState: () => ({ positions, pendingOrders: [{ ticket: "L1", symbol: "XAUUSD", type: "sell_limit" as const, lots: 0.1, price: 2360 }] }),
  quote: async () => price,
};
positions = [{ ticket: "S1", symbol: "XAUUSD", type: "buy", lots: 0.1, openPrice: 2350, currentPrice: 2352, pnl: 20 }];
await runScalpCycleSweep(deps as never, t0 + 60 * S);
assert.deepEqual(closes, ["S1"]);
assert.match(said.at(-1)!, /\+\$20.00 banked \(round 1/);
positions = [];
price = 2355;
await runScalpCycleSweep(deps as never, t0 + 70 * S);
assert.equal(opens.length, 0, "not back at the entry yet");
price = 2350.5;
await runScalpCycleSweep(deps as never, t0 + 80 * S);
assert.deepEqual(opens.map((o) => [o.type, o.lots, o.sl, o.tp]), [["buy", 0.1, 2345, 2360]], "in again, same size and stop, target the limit");
positions = [{ ticket: "S2", symbol: "XAUUSD", type: "buy", lots: 0.1, openPrice: 2350.5, currentPrice: 2352.6, pnl: 21 }];
await runScalpCycleSweep(deps as never, t0 + 90 * S);
assert.deepEqual(closes, ["S1", "S2"]);
assert.match(said.at(-1)!, /round 2, \$41.00 so far/);
positions = [];
price = 2359.9;
await runScalpCycleSweep(deps as never, t0 + 100 * S);
assert.match(said.at(-1)!, /done: price reached the limit at 2360\. 2 rounds, \$41.00 banked/);
assert.equal(listScalpCycles(userId).length, 0, "cycle finished");
console.log("   ✓\n");

console.log("[3] The skill ships with every account, and stays current");
seedStructureTargetsSkill(userId);
seedStructureTargetsSkill(userId);
const mine = listSkills(userId).filter((s) => s.name === STRUCTURE_TARGETS_SKILL_NAME);
assert.equal(mine.length, 1);
assert.match(mine[0].content, /TP1 = the previous swing/);
assert.match(mine[0].content, /TP3 = 150 pips beyond TP2/);
assert.match(mine[0].content, /\+\$20/);
console.log("   ✓\n");

console.log("=== ALL ASSERTIONS PASSED ===");
process.exit(0);
