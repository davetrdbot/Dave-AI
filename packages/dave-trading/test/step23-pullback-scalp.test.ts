import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DAVE_DATA_ROOT = mkdtempSync(join(tmpdir(), "dave-pullback-"));
process.env.DAVE_CREDENTIALS_KEY ??= "test-only-master-key-not-for-production";

/**
 * The trader: "when you place a sell limit, there is a short pullback up to it before it triggers --
 * instead of waiting, enter the pullback the opposite way (a scalp) with its own SL, TP1 and TP2.
 * TP1 at the exact place of the sell limit. Same for a buy limit." TP2 goes PAST the limit (the
 * trader's choice), short of the limit's own stop.
 */
const { planPullbackScalp, placePullbackScalp, pullbackScalpRoom, TRADING_TOOLS } = await import("../src/index.js");
type OrderRequest = import("../src/index.js").OrderRequest;

console.log("=== Step 23: a pullback scalp rides price into every limit order ===\n");

console.log("[1] SELL LIMIT above price -> BUY now, TP1 exactly at the limit, TP2 past it, short of the limit's SL");
let r = planPullbackScalp({ limitType: "sell_limit", limitEntry: 110, limitSl: 115, price: 100, lots: 0.04, sl: 97, tp2: 112, minRiskReward: 1 });
assert.ok(r.ok);
assert.equal(r.plan.side, "buy");
assert.equal(r.plan.tp1, 110, "TP1 is the sell-limit price exactly");
assert.equal(r.plan.tp2, 112, "Dave's TP2, past the limit");
assert.equal(r.plan.sl, 97);
assert.equal(r.plan.lotsEach, 0.02, "the limit's size split across the two targets");
assert.deepEqual(r.plan.defaulted, { sl: false, tp2: false });
console.log("   ✓\n");

console.log("[2] A TP2 on the wrong side, or beyond the limit's own stop, is replaced -- halfway into the stop's room");
for (const bad of [108, 116]) {
  r = planPullbackScalp({ limitType: "sell_limit", limitEntry: 110, limitSl: 115, price: 100, lots: 0.01, sl: 97, tp2: bad, minRiskReward: 1 });
  assert.ok(r.ok);
  assert.equal(r.plan.tp2, 112.5, `tp2 ${bad} -> 112.5`);
  assert.equal(r.plan.defaulted.tp2, true);
}
assert.equal(r.ok && r.plan.lotsEach, 0.01, "never below the broker minimum");
console.log("   ✓\n");

console.log("[3] BUY LIMIT below price -> SELL now, the mirror image; missing levels filled so TP1 clears the floor");
r = planPullbackScalp({ limitType: "buy_limit", limitEntry: 90, limitSl: 85, price: 100, lots: 0.02, minRiskReward: 2 });
assert.ok(r.ok);
assert.equal(r.plan.side, "sell");
assert.equal(r.plan.tp1, 90, "TP1 is the buy-limit price exactly");
assert.equal(r.plan.tp2, 87.5, "TP2 below the limit, above the limit's SL");
assert.equal(r.plan.sl, 105, "10 to TP1 at a 2:1 floor -> risk 5, stop above price");
console.log("   ✓\n");

console.log("[4] Refused when it can't pay, or when there's no pullback left");
r = planPullbackScalp({ limitType: "sell_limit", limitEntry: 110, price: 100, lots: 0.01, sl: 80, tp2: 112, minRiskReward: 1 });
assert.ok(!r.ok && /0\.50:1/.test(r.reason), "risking 20 to make 10 is refused against a 1:1 floor");
r = planPullbackScalp({ limitType: "sell_limit", limitEntry: 110, price: 111, lots: 0.01, minRiskReward: 1 });
assert.ok(!r.ok && /no pullback left/.test(r.reason));
console.log("   ✓\n");

console.log("[5] Placed as ONE position aimed at the limit (the $20 cycle runs it from there)");
const sent: OrderRequest[] = [];
const executor = {
  openOrder: async (o: OrderRequest) => (sent.push(o), { ticket: `T${sent.length}` }),
  modifyOrder: async () => {},
  closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
  deletePendingOrder: async () => {},
  listOpenPositions: async () => [],
  listPendingOrders: async () => [],
};
const plan = planPullbackScalp({ limitType: "sell_limit", limitEntry: 110, limitSl: 115, price: 100, lots: 0.02, sl: 97, tp2: 112, minRiskReward: 1 });
assert.ok(plan.ok);
const placed = await placePullbackScalp(executor, "VOL_80", plan.plan);
assert.deepEqual(placed.tickets, { tp1: "T1" });
assert.deepEqual(sent.map((o) => [o.type, o.lots, o.sl, o.tp]), [["buy", 0.02, 97, 110]], "the limit's full size, TP at the limit");
console.log("   ✓\n");

console.log("[6] Through Dave's own trade tool: a sell_limit brings its BUY pullback scalp with it");
sent.length = 0;
const tool = TRADING_TOOLS.find((t) => t.name === "trade_execute")!;
const analysis = { get: async () => ({ bid: 100, ask: 100.1 }) } as never;
const out = (await tool.execute(
  { symbol: "VOL_80", type: "sell_limit", lots: 0.02, price: 110, sl: 115, tp: 95, confidence: 80, reason: "sell the premium zone", pullback_scalp: { sl: 97, tp2: 112 } },
  { userId: "default", analysis, executor } as never,
)) as { ticket: string; pullbackScalp?: { placed: boolean; summary: string } };
assert.deepEqual(sent.map((o) => [o.type, o.price ?? null, o.tp]), [["sell_limit", 110, 95], ["buy", null, 110]]);
assert.equal(out.pullbackScalp?.placed, true);
assert.match(out.pullbackScalp!.summary, /SL 97 -- banking \$20 at a time.*limit 110/);
console.log("   " + out.pullbackScalp!.summary.replace(/\n/g, "\n   "));
console.log("   ✓\n");

console.log("[6b] Optional: a sell_limit WITHOUT pullback_scalp is just the limit");
sent.length = 0;
const plain = (await tool.execute(
  { symbol: "VOL_80", type: "sell_limit", lots: 0.02, price: 110, sl: 115, tp: 95, confidence: 80, reason: "just the limit" },
  { userId: "default", analysis, executor } as never,
)) as { pullbackScalp?: unknown };
assert.equal(sent.length, 1);
assert.equal(plain.pullbackScalp, undefined);
console.log("   ✓\n");

console.log("[6c] No room for two more positions -> no scalp (too many trades, or leverage stretched)");
const acct = { balance: 1000, freeMargin: 800, leverage: 500 };
assert.equal(pullbackScalpRoom(acct, 3, 5).ok, true, "3 open + 2 = 5, at the limit of 5: allowed");
const full = pullbackScalpRoom(acct, 4, 5);
assert.ok(!full.ok && /4 open and a limit of 5/.test(full.reason!), "4 open + 2 would be 6 > 5");
const lev = pullbackScalpRoom({ balance: 1000, freeMargin: 50, leverage: 500 }, 1, undefined);
assert.ok(!lev.ok && /leverage/.test(lev.reason!), "free margin 5% of balance: too stretched");
assert.equal(pullbackScalpRoom(undefined, 9, 5).ok, true, "no account snapshot -> left to the broker's own checks");
console.log("   ✓\n");

console.log("[7] A market order gets no scalp");
sent.length = 0;
await tool.execute({ symbol: "VOL_80", type: "sell", lots: 0.01, sl: 105, tp: 90, confidence: 80, reason: "x" }, { userId: "default", analysis, executor } as never);
assert.equal(sent.length, 1);
console.log("   ✓\n");

console.log("=== ALL ASSERTIONS PASSED ===");
process.exit(0);
