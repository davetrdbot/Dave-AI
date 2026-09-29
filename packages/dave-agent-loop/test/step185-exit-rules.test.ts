import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "dave-exit-"));
process.env.DAVE_DATA_ROOT = root;
const U = "exit-user";

function setPositions(positions: Record<string, unknown>[]) {
  const dir = join(root, "data", "ea-bridge", U);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "last-known-state.json"), JSON.stringify({ positions, pendingOrders: [] }));
}
const pos = (ticket: string, pnl: number) => ({ ticket, symbol: "XAUUSD", type: "buy", lots: 0.1, openPrice: 2650, currentPrice: 2650 + pnl / 10, sl: 2640, tp: 2670, pnl });

const { createExitRuleTools, runExitRules, listExitRules, exitRulesContextBlock } = await import("../src/exit-rules.js");
const { buildMonitorAlert } = await import("../src/trade-monitor-sweep.js");

const closed: string[] = [];
const executor = { closePosition: async (t: string) => (closed.push(t), { closedLots: 0.1, remainingLots: 0 }) } as never;
const [setRule, listRules, cancelRule] = createExitRuleTools(U);

// A trade ranging in loss: arm "close if it recovers to +6, cut at -15".
setPositions([pos("101", -4.2), pos("102", -1)]);
await assert.rejects(() => setRule.execute({ ticket: "999", closeAtProfit: 6 }), /isn't an open position/);
await assert.rejects(() => setRule.execute({ ticket: "101" }), /closeAtProfit/);
await assert.rejects(() => setRule.execute({ ticket: "101", closeAtProfit: -5 }), /already at -4.2/);
const armed = (await setRule.execute({ ticket: "101", closeAtProfit: 6, closeAtLoss: 15, note: "chopping under the Asian high" })) as { armed: { closeAtLoss: number }; summary: string };
assert.equal(armed.armed.closeAtLoss, -15, "a loss level is always a loss");
assert.match(armed.summary, /closes at \+6, cuts at -15/);
assert.match(exitRulesContextBlock(U)!, /XAUUSD #101: closes at \+6/);

// Still chopping: nothing happens.
setPositions([pos("101", 3.9), pos("102", -1)]);
assert.deepEqual(await runExitRules(U, executor), []);
assert.deepEqual(closed, []);

// Recovers to +6.3: closed, and the rule is gone.
setPositions([pos("101", 6.3), pos("102", -1)]);
const msgs = await runExitRules(U, executor);
assert.deepEqual(closed, ["101"]);
assert.match(msgs[0], /Closed XAUUSD #101 at \+6.3 -- it recovered to your \+6 exit/);
assert.equal(listExitRules(U).length, 0);

// The cut-loss side, and breakeven (0) as a profit level.
await setRule.execute({ ticket: "102", closeAtProfit: 0, closeAtLoss: -8 });
setPositions([pos("102", -8.5)]);
const cut = await runExitRules(U, executor);
assert.match(cut[0], /hit the -8 cut-loss/);
assert.deepEqual(closed, ["101", "102"]);

// A failed close keeps the rule and says so.
setPositions([pos("103", -2)]);
await setRule.execute({ ticket: "103", closeAtProfit: 1 });
setPositions([pos("103", 1.5)]);
const failing = { closePosition: async () => { throw new Error("market closed"); } } as never;
assert.match((await runExitRules(U, failing))[0], /close failed -- market closed/);
assert.equal(listExitRules(U).length, 1);

// A trade that closed some other way takes its rule with it.
setPositions([]);
assert.deepEqual(await runExitRules(U, executor), []);
assert.equal(listExitRules(U).length, 0);

// Cancel.
setPositions([pos("104", -3)]);
await setRule.execute({ ticket: "104", closeAtProfit: 2 });
assert.deepEqual(await cancelRule.execute({ ticket: "104" }), { cancelled: true });
assert.equal(((await listRules.execute()) as { rules: unknown[] }).rules.length, 0);

// Self-aware alerts: a chopping trade offers the tool; one with a rule says what's armed.
const monitor = { ticket: "104", symbol: "XAUUSD", direction: "buy", openPrice: 2650, reason: "sweep of the low", openedAt: Date.now() - 20 * 60_000, state: "losing", history: [], alerts: {}, lastPnl: -3, bestPnl: 2.1, worstPnl: -7.4, updatedAt: Date.now() } as never;
const range = buildMonitorAlert({ kind: "range", monitor }, Date.now());
assert.match(range, /No exit rule on it\. Its range so far: best \+2\.10, worst -7\.40/);
assert.match(range, /set_exit_rule/);
await setRule.execute({ ticket: "104", closeAtProfit: 2 });
assert.match(buildMonitorAlert({ kind: "range", monitor }, Date.now(), undefined, listExitRules(U)[0]), /Exit rule armed: closes at \+2/);
assert.doesNotMatch(buildMonitorAlert({ kind: "tpNear", monitor }, Date.now()), /exit rule/i, "profit-side alerts don't nag");

// The picture of a placed trade (auto-drawn into the app's chat).
const { tradeDrawing } = await import("../src/setup-drawing.js");
const candles = Array.from({ length: 40 }, (_, i) => ({ o: 2640 + i, h: 2642 + i, l: 2639 + i, c: 2641 + i }));
const d = tradeDrawing({ symbol: "XAUUSD", side: "buy", orderType: "BUY_LIMIT", entry: 2675, sl: 2665, tp: 2695, candles, timeframe: "M15", reason: "retest of the breakout", lots: 0.1 })!;
assert.equal(d.title, "XAUUSD BUY LIMIT 0.1 lots");
assert.equal(d.candles.length, 30, "the last 30 real candles");
assert.deepEqual(d.lines.map((l) => l.kind), ["entry", "sl", "tp"]);
assert.match(d.caption!, /Risk:reward 1:2\.0 -- retest of the breakout/);
assert.equal(tradeDrawing({ symbol: "X", side: "buy", entry: 1, candles: [] }), null, "no candles, no picture");

console.log("step185 exit rules: ok");
