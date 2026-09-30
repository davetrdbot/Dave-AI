import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The trader (30 Sep): "the AI was scared and closed it while it was actually profitable" -- seen
 * live: BOOM_200 closed at -0.76R before its stop ("premise invalid"), then price ran to the take
 * profit. "The market can be deceiving -- that's rule number one." Dave no longer fear-closes.
 */

const workDir = mkdtempSync(join(tmpdir(), "dave-step197-"));
process.env.DAVE_DATA_ROOT = workDir;
const { holdOrClose, protectInstead } = await import("../src/hold-to-plan.js");
const { runManagementActions: runTickActions } = await import("../src/tick-actions.js");
const { requestAlertFocus, takeAlertFocus } = await import("../src/autonomous-tick-state.js");

const calls: { kind: string; ticket: string; changes?: unknown }[] = [];
const executor = {
  openOrder: async () => ({ ticket: "T" }),
  modifyOrder: async (ticket: string, changes: unknown) => void calls.push({ kind: "modify", ticket, changes }),
  closePosition: async (ticket: string) => (calls.push({ kind: "close", ticket }), { closedLots: 0.1, remainingLots: 0 }),
  deletePendingOrder: async () => {},
  listOpenPositions: async () => [],
  listPendingOrders: async () => [],
} as never;

try {
  console.log("[1] The BOOM_200 case: short, 0.76R against, stop not hit -> held, not closed\n");
  // SELL at 1000, SL 1010, TP 965. Price 1007.6 = 0.76R against.
  const boom = { ticket: "1238463957", symbol: "BOOM_200", type: "sell", openPrice: 1000, sl: 1010, tp: 965, currentPrice: 1007.6, spread: 0.2, digits: 1 };
  const v = holdOrClose(boom);
  assert.equal(v.close, false);
  assert.match((v as { why: string }).why, /hasn't hit its stop \(1010\)/);
  console.log("   ✓\n");

  console.log("[2] A winner isn't closed early -- its stop goes to true breakeven instead\n");
  const win = { ...boom, ticket: "2", currentPrice: 990 };
  const w = holdOrClose(win);
  assert.equal(w.close, false);
  assert.equal((w as { inProfit: boolean }).inProfit, true);
  assert.match(await protectInstead(executor, win), /stop moved to breakeven 999\.7/);
  assert.deepEqual(calls.at(-1), { kind: "modify", ticket: "2", changes: { sl: 999.7 } }, "sell: entry - spread - 1 point");
  assert.match(await protectInstead(executor, { ...win, sl: 998 }), /already protects/);
  console.log("   ✓\n");

  console.log("[3] Near target (85%+), no stop, or no live price: closing is allowed\n");
  assert.equal(holdOrClose({ ...boom, currentPrice: 969 }).close, true, "31 of 35 to target");
  assert.equal(holdOrClose({ ...boom, sl: undefined }).close, true);
  assert.equal(holdOrClose({ ...boom, currentPrice: undefined }).close, true);
  console.log("   ✓\n");

  console.log("[4] A scan's CLOSE action on it is held, and says why\n");
  calls.length = 0;
  const results = await runTickActions(executor, [{ type: "CLOSE", ticket: "1238463957" }] as never, [boom] as never, []);
  assert.equal(calls.filter((c) => c.kind === "close").length, 0, "nothing closed");
  assert.match(results[0].text, /held, not closed: #1238463957 BOOM_200 hasn't hit its stop/);
  console.log("   ✓\n");

  console.log("[5] A pending order's recheck is never dropped as 'closed'\n");
  const { selfAwareFeedBlock } = await import("../src/self-aware-feed.js");
  const { publishActivity } = await import("../src/activity-bus.js");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const U = "pending-live";
  mkdirSync(join(workDir, "data", "ea-bridge", U), { recursive: true });
  writeFileSync(join(workDir, "data", "ea-bridge", U, "last-known-state.json"), JSON.stringify({ positions: [], pendingOrders: [{ ticket: "1238397108", symbol: "VOL_10", type: "buy_stop", lots: 0.02, price: 1044174 }] }));
  publishActivity(U, "background", "self_aware", { text: "PENDING ORDER STILL WAITING: VOL_10 BUY STOP #1238397108 -- 10 min" });
  const block = selfAwareFeedBlock(U, undefined, Date.now(), { symbol: "VOL_10" })!;
  assert.match(block, /PENDING ORDER STILL WAITING: VOL_10/, "kept in the scan");
  assert.ok(!/ALREADY CLOSED/.test(block));
  requestAlertFocus(U, "VOL_10", "PENDING ORDER STILL WAITING: VOL_10 BUY STOP #1238397108");
  assert.equal(takeAlertFocus(U)?.symbol, "VOL_10");
  console.log("   ✓\n");

  console.log("=== step197: ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
process.exit(0);
