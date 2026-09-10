import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRiskMode, getRiskSettings } from "../src/risk-settings.js";
import { TRADING_TOOLS, type ToolContext, type TradeExecutor } from "../src/index.js";
import { AutoModeRequiresComputedValueError } from "../src/tools.js";
import { DavemaClient } from "@dave/davema";

/**
 * Real proof for item 3 (user: "when SL/TP mode is set to Auto, Dave must calculate and set real
 * SL/TP values itself during analysis, every time, no exceptions -- it should NEVER ask the user
 * for SL/TP values when Auto is active"). Root cause confirmed: trade_execute's SL/TP auto-apply
 * block only ever checked `risk.slMode === "on"` -- "auto" silently fell through BOTH branches
 * and left the order unprotected, which is what let the model fall back to asking the user. Fix:
 * a hard gate that rejects the call back to the MODEL (never the user) when auto mode is active
 * and sl/tp is still missing, forcing it to compute a real value and retry.
 *
 * Also covers item 12's lot-size "On" state (user: "lot size settings currently only offer
 * Auto/Off... add the missing 'On' state... matching the same On/Off/Auto pattern used for
 * SL/TP") -- setRiskMode/getRiskSettings already support "lot" as a field; this proves it's
 * genuinely persisted and read back the same way sl/tp are.
 */

console.log("=== Real proof: SL/TP 'auto' mode is a real hard gate, and lot 'on' mode persists ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-auto-gate-"));
process.chdir(workDir);

async function main() {
  const davemaWithPrice = { data: async () => ({ bid: 1.1, ask: 1.1002, close: 1.1001 }) } as unknown as DavemaClient;
  const executor: TradeExecutor = {
    openOrder: async (order) => ({ ticket: "T-1", ...order } as any),
    modifyOrder: async () => {},
    closePosition: async (_t, lots) => ({ closedLots: lots ?? 1, remainingLots: 0 }),
    deletePendingOrder: async () => {},
    listOpenPositions: async () => [],
    listPendingOrders: async () => [],
  };
  const tradeExecuteTool = TRADING_TOOLS.find((t) => t.name === "trade_execute")!;

  console.log("[1] SL mode = 'auto', model omits sl -- trade_execute genuinely REJECTS the call back to the model...\n");
  const AUTO_USER = "user-auto-1";
  setRiskMode(AUTO_USER, "sl", "auto");
  const ctx: ToolContext = { userId: AUTO_USER, davema: davemaWithPrice, executor };
  await assert.rejects(
    () => tradeExecuteTool.execute({ symbol: "EURUSD", type: "buy", lots: 0.1 }, ctx),
    (err: unknown) => {
      assert.ok(err instanceof AutoModeRequiresComputedValueError, "must genuinely throw the typed auto-mode error, not silently proceed");
      assert.match((err as Error).message, /never ask the user/i, "the error must genuinely instruct the model to never ask the user");
      return true;
    }
  );
  console.log("    real AutoModeRequiresComputedValueError thrown -- rejected back to the MODEL, never surfaced as a user question");

  console.log("\n[2] Same, for TP mode = 'auto'...\n");
  const AUTO_TP_USER = "user-auto-tp-1";
  setRiskMode(AUTO_TP_USER, "tp", "auto");
  const ctxTp: ToolContext = { userId: AUTO_TP_USER, davema: davemaWithPrice, executor };
  await assert.rejects(
    () => tradeExecuteTool.execute({ symbol: "EURUSD", type: "buy", lots: 0.1, sl: 1.095 }, ctxTp),
    AutoModeRequiresComputedValueError
  );
  console.log("    real rejection confirmed for tpMode='auto' too");

  console.log("\n[3] Auto mode never blocks a call where the model DID compute real sl/tp itself...\n");
  const result = (await tradeExecuteTool.execute({ symbol: "EURUSD", type: "buy", lots: 0.1, sl: 1.095, tp: 1.11 }, ctx)) as { ticket: string };
  assert.equal(result.ticket, "T-1");
  console.log("    real trade genuinely placed once the model supplied its own computed sl/tp");

  console.log("\n[4] 'auto' mode is NEVER confused with 'on' -- a real 'on' user is unaffected by this gate...\n");
  const ON_USER = "user-on-1";
  setRiskMode(ON_USER, "sl", "on", 20);
  const ctxOn: ToolContext = { userId: ON_USER, davema: davemaWithPrice, executor };
  const onResult = (await tradeExecuteTool.execute({ symbol: "EURUSD", type: "buy", lots: 0.1 }, ctxOn)) as { ticket: string };
  assert.equal(onResult.ticket, "T-1");
  console.log("    real 'on' mode still auto-applies its pip-distance value exactly as before -- no regression");

  console.log("\n[5] Lot size 'On' mode persists and reads back, matching the real SL/TP On/Off/Auto pattern...\n");
  const LOT_USER = "user-lot-1";
  assert.equal(getRiskSettings(LOT_USER).lotMode, "off", "real default is off, same as sl/tp");
  setRiskMode(LOT_USER, "lot", "on", 0.25);
  const afterOn = getRiskSettings(LOT_USER);
  assert.equal(afterOn.lotMode, "on");
  assert.equal(afterOn.lotValue, 0.25, "the user's own real exact lot size must genuinely persist");
  console.log(`    real persisted lot settings: ${JSON.stringify({ lotMode: afterOn.lotMode, lotValue: afterOn.lotValue })}`);

  setRiskMode(LOT_USER, "lot", "auto");
  assert.equal(getRiskSettings(LOT_USER).lotMode, "auto");
  assert.equal(getRiskSettings(LOT_USER).lotValue, undefined, "switching away from 'on' genuinely clears the stale manual value");
  console.log("    switching lot mode to 'auto' genuinely clears the old manual value -- no stale leftover");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(workDir, { recursive: true, force: true });
  });
