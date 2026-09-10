import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getActiveGroupInfo, listGroups } from "../src/pair-groups.js";
import { findSetup } from "../src/find-setup.js";
import { setRiskMode } from "../src/risk-settings.js";
import { TRADING_TOOLS, type ToolContext, type TradeExecutor, type AnalysisSource } from "../src/index.js";

/**
 * Real proof for two bugs the user hit live: "the bot doesn't even know the pair to trade" and
 * "confirm if the bot took for trade even to set tp and set sl too." Both were genuine gaps: a
 * fresh user had zero pair groups and no active one until they manually visited /settings, so a
 * real scan had nothing to look at; and trade_execute never once consulted the user's real SL/TP
 * mode+value from /settings -- a trade only ever got SL/TP if the model happened to pass it as an
 * arg, silently ignoring "on" mode entirely.
 */

console.log("=== Real proof: a genuinely fresh user still gets real pairs to scan and real SL/TP ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-fresh-user-"));
process.chdir(workDir);

async function main() {
  console.log("[1] A genuinely fresh user (never touched /settings -> Pair Group) has NOTHING configured yet...\n");
  const FRESH_USER = "user-fresh-1";
  assert.equal(listGroups(FRESH_USER).length, 0, "must genuinely start with zero groups -- no fabricated defaults visible before any real read that needs them");
  assert.equal(getActiveGroupInfo(FRESH_USER).activeGroup, null, "getActiveGroupInfo itself must stay a pure read -- no side effects");

  console.log("[2] find_setup (the real consumer where 'nothing to scan' was the reported bug) self-heals right before scanning...\n");
  const stubAnalysis: AnalysisSource = { get: async () => ({ score: 0, direction: "neutral" }) };
  const scan = await findSetup(FRESH_USER, stubAnalysis, "H1");
  assert.notEqual(scan.groupName, null, "the bot must genuinely know a pair group to scan now, not silently have none");
  const info = getActiveGroupInfo(FRESH_USER);
  assert.equal(info.activeGroup?.id, "synthetic", "self-heal activates a real, sensible default -- Synthetic");
  assert.ok(info.effectiveSymbols.length > 0, "effectiveSymbols must genuinely be non-empty after self-heal");
  console.log(`    real self-healed active group: ${info.activeGroup?.name}, ${info.effectiveSymbols.length} real symbol(s)`);

  console.log("\n[3] A user who's already built their OWN groups from scratch is never silently overridden...\n");
  const CUSTOM_USER = "user-custom-1";
  const { upsertGroup, setActiveGroup } = await import("../src/pair-groups.js");
  upsertGroup(CUSTOM_USER, { id: "my-own", name: "My Own Group", symbols: ["EURUSD"] });
  setActiveGroup(CUSTOM_USER, "my-own");
  await findSetup(CUSTOM_USER, stubAnalysis, "H1");
  const customInfo = getActiveGroupInfo(CUSTOM_USER);
  assert.equal(customInfo.activeGroup?.id, "my-own", "self-heal must NEVER override a real, already-made user choice");
  assert.equal(listGroups(CUSTOM_USER).length, 1, "self-heal must never inject the 8 default groups on top of a user's own real ones");
  console.log(`    real confirmed: custom user's own choice ("${customInfo.activeGroup?.name}") untouched, still exactly 1 group`);

  console.log("\n[4] trade_execute now genuinely applies the user's real SL/TP 'on' mode when the model omits sl/tp...\n");
  const TRADER = "user-trader-1";
  setRiskMode(TRADER, "sl", "on", 20); // 20 real pips
  setRiskMode(TRADER, "tp", "on", 40); // 40 real pips
  let openedOrder: { symbol: string; type: string; sl?: number; tp?: number } | undefined;
  const executor: TradeExecutor = {
    openOrder: async (order) => {
      openedOrder = order;
      return { ticket: "T-1" };
    },
    modifyOrder: async () => {},
    closePosition: async (_t, lots) => ({ closedLots: lots ?? 1, remainingLots: 0 }),
    deletePendingOrder: async () => {},
    listOpenPositions: async () => [],
    listPendingOrders: async () => [],
  };
  const analysisWithPrice: AnalysisSource = { get: async () => ({ bid: 1.1, ask: 1.1002, close: 1.1001 }) };
  const ctx: ToolContext = { userId: TRADER, analysis: analysisWithPrice, executor };
  const tradeExecuteTool = TRADING_TOOLS.find((t) => t.name === "trade_execute")!;
  const result = (await tradeExecuteTool.execute({ symbol: "EURUSD", type: "buy", lots: 0.1 }, ctx)) as { ticket: string };
  assert.equal(result.ticket, "T-1");
  assert.ok(openedOrder, "the order must genuinely have reached the executor");
  assert.ok(openedOrder!.sl !== undefined, "SL must genuinely be set from the user's real risk settings, not left blank");
  assert.ok(openedOrder!.tp !== undefined, "TP must genuinely be set from the user's real risk settings, not left blank");
  assert.ok(openedOrder!.sl! < 1.1002, "a BUY's real SL must be genuinely below the real entry price");
  assert.ok(openedOrder!.tp! > 1.1002, "a BUY's real TP must be genuinely above the real entry price");
  console.log(`    real order sent to the executor: ${JSON.stringify(openedOrder)}`);

  console.log("\n[5] An explicit sl/tp the model DOES pass is never overridden by the risk-settings default...\n");
  const explicitResult = (await tradeExecuteTool.execute({ symbol: "GBPUSD", type: "sell", lots: 0.1, sl: 1.5, tp: 1.3 }, ctx)) as { ticket: string };
  assert.equal(explicitResult.ticket, "T-1");
  assert.equal(openedOrder!.sl, 1.5, "an explicit sl must win over the real risk-settings default");
  assert.equal(openedOrder!.tp, 1.3, "an explicit tp must win over the real risk-settings default");

  console.log("\n[6] 'off' mode (the real default) genuinely leaves SL/TP unset -- never invents one...\n");
  const OFF_USER = "user-off-1";
  const ctxOff: ToolContext = { userId: OFF_USER, analysis: analysisWithPrice, executor };
  const offResult = (await tradeExecuteTool.execute({ symbol: "USDJPY", type: "buy", lots: 0.1 }, ctxOff)) as { ticket: string };
  assert.equal(offResult.ticket, "T-1");
  assert.equal(openedOrder!.sl, undefined, "'off' mode must never fabricate an SL");
  assert.equal(openedOrder!.tp, undefined, "'off' mode must never fabricate a TP");

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
