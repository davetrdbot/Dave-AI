import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.DAVE_DATA_ROOT = mkdtempSync(join(tmpdir(), "sl-off-"));

/** SL off = no stop from ANY path; default settings included; copy trades keep their SL. */
const { SlOffGuardExecutor, SlOffError } = await import("../src/sl-off-guard.js");
const { getRiskSettings, setRiskMode } = await import("@dave/trading");
const { saveNousTrades } = await import("../src/nous/store.js");

const calls: { op: string; arg: unknown }[] = [];
const inner = {
  openOrder: async (o: unknown) => (calls.push({ op: "open", arg: o }), { ticket: "1" }),
  modifyOrder: async (t: string, c: unknown) => void calls.push({ op: "modify", arg: { t, c } }),
  closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
  deletePendingOrder: async () => {},
  listOpenPositions: async () => [],
  listPendingOrders: async () => [],
};
const ex = new SlOffGuardExecutor("u", inner);

assert.equal(getRiskSettings("u").slMode, "off");
assert.equal(getRiskSettings("u").slOffChosen, true, "the default 'off' is really off");

await ex.openOrder({ symbol: "XAUUSD", type: "BUY", lots: 0.02, sl: 2640, tp: 2680 } as never);
assert.equal((calls[0].arg as { sl?: number }).sl, undefined, "the stop is stripped");
assert.equal((calls[0].arg as { tp?: number }).tp, 2680, "the target stays");

await assert.rejects(ex.modifyOrder("9", { sl: 2645 }), SlOffError, "setting a stop is refused");
await assert.rejects(ex.modifyOrder("9", { sl: 2645, tp: 2690 }), /stop was NOT set/);
assert.deepEqual(calls.at(-1)!.arg, { t: "9", c: { tp: 2690 } }, "the target part still goes through");
await ex.modifyOrder("9", { sl: null });
assert.deepEqual(calls.at(-1)!.arg, { t: "9", c: { sl: null } }, "removing a stop is always allowed");

saveNousTrades("u", [{ ticket: "77", signalId: "s", symbol: "XAUUSD", side: "buy", lots: 0.01, entry: 2650, placedAt: 0 } as never]);
await ex.modifyOrder("77", { sl: 2640 });
assert.deepEqual(calls.at(-1)!.arg, { t: "77", c: { sl: 2640 } }, "copy-trade signals keep their SL");
await ex.openOrder({ symbol: "XAUUSD", type: "BUY", lots: 0.01, sl: 2640, comment: "Nous signal" } as never);
assert.equal((calls.at(-1)!.arg as { sl?: number }).sl, 2640);

setRiskMode("u", "sl", "auto");
await ex.modifyOrder("9", { sl: 2645 });
assert.deepEqual(calls.at(-1)!.arg, { t: "9", c: { sl: 2645 } }, "with SL on/auto stops work as before");
console.log("=== ALL ASSERTIONS PASSED ===");
