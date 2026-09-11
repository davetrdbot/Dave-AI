import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { TelegramClient } from "@dave/telegram";
import type { TradeExecutor } from "@dave/trading";
import { buildFullToolRegistry } from "../src/full-registry.js";

/**
 * Real proof, direct fix for the user's live complaint: minutes after Dave itself placed a real
 * XAUUSD sell_limit (the user gave it the exact entry/TP/SL and said "Place this trade"), Dave
 * later asked "There's a pending order on the account I didn't place -- did you put this in?"
 * about the EXACT trade it had just placed. Root cause confirmed via code trace: trade_execute
 * and the trade journal (logTrade) were fully disjoint -- nothing auto-logged a successful trade,
 * and there was no read tool over the journal even if it had been. This proves both halves are
 * now real: a trade_execute call that genuinely succeeds is auto-logged (no separate journal_trade
 * call needed), and a completely separate later turn (simulating the autonomous cycle or the main
 * chat asking days later) can genuinely find it via get_trade_history instead of asking the user.
 */

console.log("=== Real proof: a placed trade is auto-logged and later genuinely queryable, not forgotten ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-trade-autolog-"));
process.chdir(workDir);
const OWNER = "user-trade-autolog-1";
const CHAT_ID = 991122;

try {
  const db = new DaveDatabase(join(workDir, "dave.db"));
  const client = new TelegramClient("000000:fake-token-for-transport-mock");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 })) as typeof fetch;

  const placedOrders: { symbol: string; type: string }[] = [];
  const executor: TradeExecutor = {
    openOrder: async (order) => {
      placedOrders.push({ symbol: order.symbol, type: order.type });
      return { ticket: `T-${order.symbol}` };
    },
    modifyOrder: async () => {},
    closePosition: async (_t, lots) => ({ closedLots: lots ?? 1, remainingLots: 0 }),
    deletePendingOrder: async () => {},
    listOpenPositions: async () => [],
    listPendingOrders: async () => [],
  };
  try {
    console.log("[1] A real trade_execute call that genuinely succeeds is auto-logged -- no separate journal_trade call needed...\n");
    const registry = buildFullToolRegistry({ userId: OWNER, db, executor, telegram: { client, chatId: CHAT_ID } });
    const result: any = await registry.execute("trade_execute", {
      symbol: "XAUUSD",
      type: "sell_limit",
      lots: 0.01,
      price: 4397.42,
      sl: 4437.87,
      tp: 4347.56,
      confidence: 58,
      reason: "user-requested exact entry/TP/SL",
    });
    assert.equal(result.ticket, "T-XAUUSD");
    assert.deepEqual(placedOrders, [{ symbol: "XAUUSD", type: "sell_limit" }]);
    console.log(`    real trade placed: ${JSON.stringify(result)}`);

    console.log("\n[2] A COMPLETELY SEPARATE later turn (simulating a new autonomous cycle or a later chat message) genuinely finds it via get_trade_history, without asking the user...\n");
    const historyResult: any = await registry.execute("get_trade_history", { hours: 24 });
    console.log(`    real trade history: ${JSON.stringify(historyResult)}`);
    assert.equal(historyResult.length, 1, "the trade Dave just placed must genuinely show up in its own trade history");
    assert.equal(historyResult[0].symbol, "XAUUSD");
    assert.equal(historyResult[0].direction, "sell");
    assert.equal(historyResult[0].sl, 4437.87);
    assert.equal(historyResult[0].tp, 4347.56);
    assert.equal(historyResult[0].confluenceScore, 58);
    assert.ok(historyResult[0].reasoning.some((r: string) => r.includes("exact entry")), "the real reason passed to trade_execute must genuinely be preserved");

    console.log("\n[3] A trade that does NOT succeed (needs approval, no ticket yet) is genuinely NOT logged as if it were placed...\n");
    const { setConfidenceThreshold, setAutoApproveBelowThreshold } = await import("@dave/trading");
    setConfidenceThreshold(OWNER, 90);
    setAutoApproveBelowThreshold(OWNER, false);
    const pendingResult: any = await registry.execute("trade_execute", { symbol: "EURUSD", type: "buy", lots: 0.1, sl: 1.09, tp: 1.11, confidence: 40, reason: "low confidence" });
    assert.equal(pendingResult.needsApproval, true);
    const historyAfterPending: any = await registry.execute("get_trade_history", { hours: 24 });
    assert.equal(historyAfterPending.length, 1, "a trade still queued for approval (no ticket yet) must NOT be logged as a real placed trade");
    console.log(`    confirmed: still only 1 real logged trade -- the queued EURUSD approval was correctly NOT counted as placed`);

    console.log("\n=== ALL ASSERTIONS PASSED ===");
  } finally {
    globalThis.fetch = realFetch;
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
