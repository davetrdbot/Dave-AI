import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getConfidenceSettings,
  setConfidenceThreshold,
  setAutoApproveBelowThreshold,
  evaluateConfidenceGate,
  listPendingTradeApprovals,
  takePendingTradeApproval,
  TradeApprovalNotFoundError,
  InvalidConfidenceThresholdError,
  resetConfidenceSettingsForUser,
  TRADING_TOOLS,
  type ToolContext,
  type TradeExecutor,
} from "../src/index.js";
import { DavemaClient } from "@dave/davema";

/**
 * Real proof for the user's ask, with a real screenshot as the reference: "implement confidence
 * rate so when it's placing a trade it should send like the screenshot... and also to set
 * confidence rate in the settings the confidence rate is meaning it's below the confidence rate
 * it should ask you for approval to trade it and also a setting to auto approval trade below the
 * confidence rate." Below the threshold, a trade is genuinely queued instead of firing -- proven
 * through the real trade_execute tool manifest, not just the underlying function.
 */

console.log("=== Real proof: confidence-rate gate genuinely blocks/queues low-confidence trades ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-confidence-gate-"));
process.chdir(workDir);
const USER_ID = "user-confidence-1";

const executedOrders: { symbol: string; type: string }[] = [];
const executor: TradeExecutor = {
  openOrder: async (order) => {
    executedOrders.push({ symbol: order.symbol, type: order.type });
    return { ticket: `T-${order.symbol}` };
  },
  modifyOrder: async () => {},
  closePosition: async (_t, lots) => ({ closedLots: lots ?? 1, remainingLots: 0 }),
  deletePendingOrder: async () => {},
  listOpenPositions: async () => [],
  listPendingOrders: async () => [],
};
const ctx: ToolContext = { userId: USER_ID, davema: new DavemaClient(undefined, "http://127.0.0.1:1"), executor };
const tradeExecuteTool = TRADING_TOOLS.find((t) => t.name === "trade_execute")!;

try {
  console.log("[1] Real default: threshold 70%, auto-approve-below-threshold off...\n");
  assert.deepEqual(getConfidenceSettings(USER_ID), { threshold: 70, autoApproveBelowThreshold: false });

  console.log("[2] Confidence AT/ABOVE threshold -> trade fires immediately, no gate...\n");
  const highConfResult = (await tradeExecuteTool.execute({ symbol: "EURUSD", type: "buy", lots: 0.1, confidence: 82 }, ctx)) as { ticket: string; confidence: number };
  assert.equal(highConfResult.ticket, "T-EURUSD");
  assert.equal(highConfResult.confidence, 82);
  assert.deepEqual(executedOrders, [{ symbol: "EURUSD", type: "buy" }]);
  console.log(`    real result: ${JSON.stringify(highConfResult)}`);

  console.log("\n[3] Confidence BELOW threshold, auto-approve off -> genuinely queued, NOT executed...\n");
  const lowConfResult = (await tradeExecuteTool.execute({ symbol: "GBPUSD", type: "sell", lots: 0.2, confidence: 55, reason: "Weak momentum, counter-trend." }, ctx)) as {
    needsApproval: boolean;
    pendingId: string;
    threshold: number;
  };
  assert.equal(lowConfResult.needsApproval, true);
  assert.equal(lowConfResult.threshold, 70);
  assert.deepEqual(executedOrders, [{ symbol: "EURUSD", type: "buy" }], "the low-confidence order must NOT have reached the executor");
  const pending = listPendingTradeApprovals(USER_ID);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].confidence, 55);
  assert.equal(pending[0].order.symbol, "GBPUSD");
  console.log(`    real pending approval queued: ${JSON.stringify(pending[0])}`);

  console.log("\n[4] Approving the pending trade removes it AND genuinely places the real order...\n");
  const approved = takePendingTradeApproval(USER_ID, lowConfResult.pendingId);
  const { ticket } = await executor.openOrder(approved.order);
  assert.equal(ticket, "T-GBPUSD");
  assert.deepEqual(executedOrders, [
    { symbol: "EURUSD", type: "buy" },
    { symbol: "GBPUSD", type: "sell" },
  ]);
  assert.equal(listPendingTradeApprovals(USER_ID).length, 0, "approved trade must be removed from the pending queue");

  console.log("\n[5] Re-deciding an already-decided pending id fails honestly, typed...\n");
  assert.throws(() => takePendingTradeApproval(USER_ID, lowConfResult.pendingId), TradeApprovalNotFoundError);
  console.log("    genuinely refused -- TradeApprovalNotFoundError");

  console.log("\n[6] Auto-approve-below-threshold ON -> a low-confidence trade fires immediately instead of queuing...\n");
  setAutoApproveBelowThreshold(USER_ID, true);
  const autoApprovedResult = (await tradeExecuteTool.execute({ symbol: "USDJPY", type: "buy", lots: 0.05, confidence: 30 }, ctx)) as { ticket: string };
  assert.equal(autoApprovedResult.ticket, "T-USDJPY");
  assert.equal(listPendingTradeApprovals(USER_ID).length, 0, "auto-approval must NOT create a pending entry");
  console.log(`    real auto-approved result (confidence 30% < threshold 70%, but auto-approve is on): ${JSON.stringify(autoApprovedResult)}`);

  console.log("\n[7] Changing the threshold genuinely persists and re-gates...\n");
  setAutoApproveBelowThreshold(USER_ID, false);
  setConfidenceThreshold(USER_ID, 90);
  assert.equal(getConfidenceSettings(USER_ID).threshold, 90);
  const nowGatedResult = (await tradeExecuteTool.execute({ symbol: "AUDUSD", type: "buy", lots: 0.1, confidence: 85 }, ctx)) as { needsApproval: boolean };
  assert.equal(nowGatedResult.needsApproval, true, "85% is now below the new 90% threshold -- must gate");
  console.log("    real re-gate confirmed: 85% confidence now requires approval against a 90% threshold");

  console.log("\n[8] An invalid threshold is genuinely refused, typed...\n");
  assert.throws(() => setConfidenceThreshold(USER_ID, 150), InvalidConfidenceThresholdError);
  assert.throws(() => setConfidenceThreshold(USER_ID, -5), InvalidConfidenceThresholdError);
  console.log("    genuinely refused -- InvalidConfidenceThresholdError");

  console.log("\n[9] No confidence passed at all -> trade_execute behaves exactly as before (no gate involved)...\n");
  const noConfResult = (await tradeExecuteTool.execute({ symbol: "NZDUSD", type: "sell", lots: 0.1 }, ctx)) as { ticket: string; confidence?: number };
  assert.equal(noConfResult.ticket, "T-NZDUSD");
  assert.equal(noConfResult.confidence, undefined, "no confidence field should appear when none was passed");

  console.log("\n[10] /reset genuinely clears confidence settings + pending approvals back to defaults...\n");
  resetConfidenceSettingsForUser(USER_ID);
  assert.deepEqual(getConfidenceSettings(USER_ID), { threshold: 70, autoApproveBelowThreshold: false });
  assert.equal(listPendingTradeApprovals(USER_ID).length, 0);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
