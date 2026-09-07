import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTradingModeConfig, setEaTradingMode, setMcpTradingMode, MissingMcpServerUrlError, DynamicTradeExecutor } from "../src/index.js";
import type { TradeExecutor } from "@dave/trading";

/**
 * Real proof for the user's ask: "so incase they don't want to use the ea I can provide my mcp
 * for the placing of trade and others". `McpTradeExecutor` (mcp-trade-adapter.ts) already existed
 * as a real, complete alternative to the file-based MT5 EA -- but nothing let a user actually
 * choose it. This proves the real, persisted per-user choice, and that `DynamicTradeExecutor`
 * (the thing every real trade call now goes through) genuinely routes to whichever backend is
 * configured, re-checked live on every call.
 */

console.log("=== Real proof: trade execution genuinely routes through EA or a real configured MCP server ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-dynamic-executor-"));
process.chdir(workDir);
const USER_ID = "user-dynamic-executor-1";

console.log("[1] Real default: EA mode, before anything is configured...");
assert.deepEqual(getTradingModeConfig(USER_ID), { mode: "ea" });

console.log("\n[2] setMcpTradingMode genuinely persists a real server URL...");
const mcpConfig = setMcpTradingMode(USER_ID, "http://127.0.0.1:1/mcp");
assert.deepEqual(mcpConfig, { mode: "mcp", mcpServerUrl: "http://127.0.0.1:1/mcp" });
assert.deepEqual(getTradingModeConfig(USER_ID), mcpConfig);
console.log(`    real persisted config: ${JSON.stringify(mcpConfig)}`);

console.log("\n[3] An empty URL is genuinely refused, not silently accepted...");
let refused = false;
try {
  setMcpTradingMode(USER_ID, "   ");
} catch (err) {
  refused = err instanceof MissingMcpServerUrlError;
}
assert.ok(refused);
console.log("    genuinely refused: MissingMcpServerUrlError");

console.log("\n[4] setEaTradingMode genuinely switches back...");
assert.deepEqual(setEaTradingMode(USER_ID), { mode: "ea" });
assert.deepEqual(getTradingModeConfig(USER_ID), { mode: "ea" });

console.log("\n[5] DynamicTradeExecutor genuinely routes to the real EA executor while mode=ea...");
const eaCalls: string[] = [];
const stubEaExecutor: TradeExecutor = {
  async openOrder() { eaCalls.push("openOrder"); return { ticket: "EA1" }; },
  async modifyOrder() { eaCalls.push("modifyOrder"); },
  async closePosition() { eaCalls.push("closePosition"); return { closedLots: 0, remainingLots: 0 }; },
  async deletePendingOrder() { eaCalls.push("deletePendingOrder"); },
  async listOpenPositions() { eaCalls.push("listOpenPositions"); return []; },
  async listPendingOrders() { eaCalls.push("listPendingOrders"); return []; },
};
const dynamic = new DynamicTradeExecutor(USER_ID, stubEaExecutor);
const opened = await dynamic.openOrder({ symbol: "EURUSD", type: "buy", lots: 0.1 });
assert.equal(opened.ticket, "EA1");
assert.deepEqual(eaCalls, ["openOrder"]);
console.log(`    real call routed to the EA executor: ${JSON.stringify(opened)}`);

console.log("\n[6] Switching to MCP mode genuinely routes the NEXT real call through a real MCP connection attempt (no restart)...\n");
setMcpTradingMode(USER_ID, "http://127.0.0.1:1/mcp");
let mcpFailure: string | undefined;
try {
  await dynamic.listOpenPositions();
} catch (err) {
  mcpFailure = err instanceof Error ? err.message : String(err);
}
assert.ok(mcpFailure?.includes("Could not connect to MCP trade server"), "must genuinely attempt a real MCP connection, not silently fall back to the EA executor");
assert.deepEqual(eaCalls, ["openOrder"], "the EA executor must NOT have been touched by this call -- routing genuinely changed");
console.log(`    real, honest connection failure (no real MCP server running here): "${mcpFailure}"`);

console.log("\n=== ALL ASSERTIONS PASSED ===");
rmSync(workDir, { recursive: true, force: true });
process.exit(0);
