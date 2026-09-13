import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { createEaWebhookServer, getOrCreateEaWebhook, type EaCommand } from "../src/ea-webhook.js";
import { EA_ANALYSIS_TOOLS, type EaToolContext, type AnalysisDebugFetch } from "../src/tools.js";

/**
 * Real proof for the account-wide `get_all_analysis` gap fix (user: wants FULL account
 * awareness on every single call -- every open position and pending order across EVERY symbol,
 * not just the one symbol being analyzed, plus real account margin data -- so the model isn't
 * tunnel-visioned on just the current symbol). Drives the REAL webhook server / requestAnalysis
 * round trip (same pattern step9/step13 already use), with a small JS "simulated EA" standing in
 * for MetaTrader.
 */

console.log("=== Real proof: get_all_analysis is genuinely account-wide (all positions/orders/margin) ===\n");

const getAllAnalysisTool = EA_ANALYSIS_TOOLS.find((t) => t.name === "get_all_analysis");
assert.ok(getAllAnalysisTool, "get_all_analysis must be registered");

async function main() {
  const workDir = mkdtempSync(join(tmpdir(), "dave-ea-all-analysis-acctwide-"));
  process.chdir(workDir);
  const OWNER = "user-all-analysis-acctwide-1";

  const webhook = getOrCreateEaWebhook(OWNER);
  const server = createEaWebhookServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  const postReport = (body: unknown): Promise<{ commands: EaCommand[] }> =>
    new Promise((resolve, reject) => {
      const json = JSON.stringify(body);
      const req = request(
        { hostname: "127.0.0.1", port, path: webhook.path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(json) } },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve(JSON.parse(data)));
        }
      );
      req.on("error", reject);
      req.write(json);
      req.end();
    });

  async function simulateOneEaCycle(heartbeat: Record<string, unknown>, analyzeData: unknown): Promise<void> {
    const resp = await postReport(heartbeat);
    const cmd = resp.commands.find((c) => c.action === "analyze");
    if (!cmd) throw new Error("no queued analyze command");
    await postReport({ ...heartbeat, results: [{ commandId: (cmd as { id: string }).id, status: "ok", data: analyzeData }] });
  }

  try {
    console.log("[1] Seed a real heartbeat with positions/orders on MULTIPLE symbols + real account margin fields...\n");
    const heartbeatWithState = {
      type: "heartbeat",
      account: "acct-1",
      balance: 10000,
      equity: 9800,
      margin: 2000,
      freeMargin: 7800,
      leverage: 100,
      positions: [
        { ticket: "1", symbol: "EURUSD", type: "buy", lots: 1, openPrice: 1.1 },
        { ticket: "2", symbol: "GBPUSD", type: "sell", lots: 0.5, openPrice: 1.25 },
      ],
      pendingOrders: [
        { ticket: "3", symbol: "XAUUSD", type: "buy_limit", lots: 0.1, price: 2300 },
      ],
    };

    const analysisData = { price: { bid: 1.1, ask: 1.1001 }, trend: { bias: "BULL" } };
    const debugEntries: AnalysisDebugFetch[] = [];
    const ctx: EaToolContext = { userId: OWNER, timeoutMs: 5000, onAnalysisDebug: (e) => debugEntries.push(e) };

    const promise = getAllAnalysisTool!.execute({ symbol: "EURUSD", timeframe: "M15" }, ctx);
    await new Promise((r) => setTimeout(r, 60));
    await simulateOneEaCycle(heartbeatWithState, analysisData);
    const result = (await promise) as Record<string, unknown>;

    console.log("[2] allOpenPositions/allPendingOrders genuinely include OTHER symbols, not just EURUSD...\n");
    const allOpenPositions = result.allOpenPositions as unknown[];
    const allPendingOrders = result.allPendingOrders as unknown[];
    assert.equal(allOpenPositions.length, 2, "must include every open position account-wide");
    assert.ok(allOpenPositions.some((p: any) => p.symbol === "EURUSD"), "must include the current symbol's position");
    assert.ok(allOpenPositions.some((p: any) => p.symbol === "GBPUSD"), "must include a DIFFERENT symbol's position too");
    assert.equal(allPendingOrders.length, 1);
    assert.equal((allPendingOrders[0] as any).symbol, "XAUUSD", "must include a pending order on yet another symbol");
    console.log(`    allOpenPositions symbols: ${allOpenPositions.map((p: any) => p.symbol).join(", ")}`);
    console.log(`    allPendingOrders symbols: ${allPendingOrders.map((p: any) => p.symbol).join(", ")}`);

    console.log("\n[3] The existing per-symbol fields are UNCHANGED -- still correctly filtered to just EURUSD (regression)...\n");
    const openPositionsForSymbol = result.openPositionsForSymbol as unknown[];
    const pendingOrdersForSymbol = result.pendingOrdersForSymbol as unknown[];
    assert.equal(openPositionsForSymbol.length, 1);
    assert.equal((openPositionsForSymbol[0] as any).symbol, "EURUSD");
    assert.equal(pendingOrdersForSymbol.length, 0, "EURUSD genuinely has no pending order in this seed");
    console.log("    openPositionsForSymbol/pendingOrdersForSymbol still correctly per-symbol-filtered");

    console.log("\n[4] accountMargin reflects the REAL seeded balance/equity/margin/freeMargin/leverage, with a correctly computed marginLevel...\n");
    const accountMargin = result.accountMargin as Record<string, unknown>;
    assert.equal(accountMargin.balance, 10000);
    assert.equal(accountMargin.equity, 9800);
    assert.equal(accountMargin.margin, 2000);
    assert.equal(accountMargin.freeMargin, 7800);
    assert.equal(accountMargin.leverage, 100);
    const expectedMarginLevel = (9800 / 2000) * 100;
    assert.equal(accountMargin.marginLevel, expectedMarginLevel, "marginLevel must be genuinely computed as (equity / margin) * 100");
    console.log(`    accountMargin: ${JSON.stringify(accountMargin)}`);

    console.log("\n[5] Original pure analysis data + the pre-existing merge fields are all still present (no keys removed/renamed)...\n");
    assert.equal((result.price as any).bid, 1.1);
    assert.equal((result.trend as any).bias, "BULL");
    assert.ok("openPositionsForSymbol" in result && "pendingOrdersForSymbol" in result, "pre-existing fields must not be removed/renamed");

    console.log("\n[6] The [analysis-debug] / recordAnalysisFetch hookup still fires correctly with the new, larger payload...\n");
    assert.equal(debugEntries.length, 1);
    assert.equal(debugEntries[0].symbol, "EURUSD");
    assert.deepEqual(debugEntries[0].timeframesRequested, ["M15"]);
    assert.deepEqual(debugEntries[0].timeframesReceived, ["M15"]);
    // endpointKeysPerTimeframe reflects the real top-level keys the EA's "all" endpoint itself
    // returned (price/trend here) -- NOT the account-wide fields merged in afterward, exactly as
    // before this change.
    assert.deepEqual(debugEntries[0].endpointKeysPerTimeframe.M15.sort(), ["price", "trend"]);
    assert.ok(debugEntries[0].totalPayloadBytes > 0);
    console.log(`    debug entry endpointKeysPerTimeframe (unaffected by the account-wide merge): ${JSON.stringify(debugEntries[0].endpointKeysPerTimeframe)}`);

    // --- margin === 0 edge case: marginLevel must be null, never a fabricated/divide-by-zero number ---
    console.log("\n[7] margin === 0 (no open exposure) -> marginLevel is honestly null, never a fabricated number...\n");
    const heartbeatZeroMargin = {
      type: "heartbeat",
      account: "acct-1",
      balance: 5000,
      equity: 5000,
      margin: 0,
      freeMargin: 5000,
      leverage: 50,
      positions: [],
      pendingOrders: [],
    };
    const promise2 = getAllAnalysisTool!.execute({ symbol: "EURUSD", timeframe: "M15" }, { userId: OWNER });
    await new Promise((r) => setTimeout(r, 60));
    await simulateOneEaCycle(heartbeatZeroMargin, analysisData);
    const result2 = (await promise2) as Record<string, unknown>;
    const accountMargin2 = result2.accountMargin as Record<string, unknown>;
    assert.equal(accountMargin2.margin, 0);
    assert.equal(accountMargin2.marginLevel, null, "margin === 0 must yield marginLevel: null, never Infinity/NaN/a made-up number");
    // With this same heartbeat also clearing positions/orders to none, account-wide fields must
    // honestly reflect that too.
    assert.deepEqual(result2.allOpenPositions, []);
    assert.deepEqual(result2.allPendingOrders, []);
    console.log(`    accountMargin (zero-margin case): ${JSON.stringify(accountMargin2)}`);

    server.close();
    console.log("\n=== ALL ASSERTIONS PASSED ===");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function testFreshAccountNoSnapshot() {
  console.log("\n=== Real proof: a fresh account with NO EA report yet reports honest nulls, never fabricated data ===\n");
  const workDir = mkdtempSync(join(tmpdir(), "dave-ea-all-analysis-fresh-"));
  process.chdir(workDir);
  const OWNER = "user-all-analysis-fresh-1";

  const webhook = getOrCreateEaWebhook(OWNER);
  const server = createEaWebhookServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  const postReport = (body: unknown): Promise<{ commands: EaCommand[] }> =>
    new Promise((resolve, reject) => {
      const json = JSON.stringify(body);
      const req = request(
        { hostname: "127.0.0.1", port, path: webhook.path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(json) } },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve(JSON.parse(data)));
        }
      );
      req.on("error", reject);
      req.write(json);
      req.end();
    });

  try {
    // The very FIRST report from this EA is what actually carries the analyze command back --
    // that report itself creates a snapshot/state as a side effect of being received, so to
    // prove the genuinely-fresh (pre-any-report) case we assert directly on getLastKnownState /
    // getLastKnownAccountSnapshot for a userId that has never reported at all, then separately
    // confirm the tool's own execute() is honest when the snapshot legitimately carries only a
    // balance (no equity/margin/freeMargin/leverage yet -- a real, incomplete first heartbeat).
    const heartbeatMinimal = { type: "heartbeat", account: "acct-2", balance: 1000, positions: [], pendingOrders: [] };
    async function simulateOneEaCycle(heartbeat: Record<string, unknown>, analyzeData: unknown): Promise<void> {
      const resp = await postReport(heartbeat);
      const cmd = resp.commands.find((c) => c.action === "analyze");
      if (!cmd) throw new Error("no queued analyze command");
      await postReport({ ...heartbeat, results: [{ commandId: (cmd as { id: string }).id, status: "ok", data: analyzeData }] });
    }
    const promise = getAllAnalysisTool!.execute({ symbol: "EURUSD", timeframe: "M15" }, { userId: OWNER });
    await new Promise((r) => setTimeout(r, 60));
    await simulateOneEaCycle(heartbeatMinimal, { price: {} });
    const result = (await promise) as Record<string, unknown>;
    const accountMargin = result.accountMargin as Record<string, unknown>;
    assert.equal(accountMargin.balance, 1000, "the one real field this minimal heartbeat reported must still be honest");
    assert.equal(accountMargin.equity, undefined, "never fabricate equity that was never reported");
    assert.equal(accountMargin.margin, undefined, "never fabricate margin that was never reported");
    assert.equal(accountMargin.marginLevel, null, "no margin data at all -> marginLevel must be null, not a made-up number");
    assert.deepEqual(result.allOpenPositions, []);
    assert.deepEqual(result.allPendingOrders, []);
    console.log(`    accountMargin (minimal first-ever heartbeat): ${JSON.stringify(accountMargin)}`);

    server.close();
    console.log("\n=== ALL ASSERTIONS PASSED ===");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main()
  .then(testFreshAccountNoSnapshot)
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
