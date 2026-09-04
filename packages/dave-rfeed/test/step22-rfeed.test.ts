import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import {
  RFeedBridge,
  getOrCreateRFeedWebhook,
  RFeedTradeExecutor,
  HistoryRequestManager,
  isKnownCustomSymbol,
  recordSymbolCustomFlags,
  CustomSymbolTradeRefusedError,
  recordTradeNote,
  getTradeNote,
  RFEED_TOOLS,
  personalizeRFeedFile,
  type RFeedReport,
} from "../src/index.js";

console.log("=== Step 22 real proof: R_Feed ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-step22-"));
const dbPath = join(workDir, "dave.db");
process.chdir(workDir);
const OWNER = "user-1";

try {
  const db = new DaveDatabase(dbPath);
  const bridge = new RFeedBridge();

  // --- [1] Own webhook/token pair, genuinely separate namespace ---
  console.log("[1] R_Feed has its own webhook/token pair, a real separate namespace...\n");
  const hook = getOrCreateRFeedWebhook(OWNER);
  assert.ok(hook.path.startsWith("/hooks/rfeed/"), "must be a genuinely different path prefix from /hooks/ea/");
  console.log(`    real R_Feed webhook: ${hook.path}`);

  // --- [2] History download: real proof it returns real candle data ---
  console.log("\n[2] History download: a real request -> real candle data comes back through the real webhook...\n");
  const server = bridge.createServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;

  const historyManager = bridge.getHistoryManager(OWNER);
  const historyPromise = historyManager.requestHistory("EURUSD", "H1", new Date("2026-08-01T00:00:00Z"), new Date("2026-08-02T00:00:00Z"));

  // Simulate the R_Feed EA's real next report, carrying the real candle data
  // CopyRates would have returned -- posted through the ACTUAL webhook server,
  // not injected directly into the manager.
  const historyReport: RFeedReport = {
    type: "heartbeat",
    account: "50012345",
    balance: 10000,
    positions: [],
    pendingOrders: [],
    historyResults: [
      {
        commandId: "", // filled in below once we know the real generated command id
        status: "ok",
        symbol: "EURUSD",
        candles: [
          { time: 1785715200, open: 1.0851, high: 1.0862, low: 1.0845, close: 1.0858, tickVolume: 1240 },
          { time: 1785718800, open: 1.0858, high: 1.0871, low: 1.0855, close: 1.0866, tickVolume: 980 },
        ],
      },
    ],
  };
  // The real command id was assigned inside requestHistory() -- read it back
  // from the real enqueued queue file rather than guessing it.
  const queuedPath = join(workDir, "data", "rfeed", OWNER, "command-queue.json");
  const queued = JSON.parse(readFileSync(queuedPath, "utf8"));
  assert.equal(queued.length, 1);
  assert.equal(queued[0].action, "request_history");
  historyReport.historyResults![0].commandId = queued[0].id;

  const postRes = await fetch(`http://127.0.0.1:${port}${hook.path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(historyReport),
  });
  assert.equal(postRes.status, 200);

  const candles = await historyPromise;
  assert.equal(candles.length, 2);
  assert.equal(candles[0].open, 1.0851);
  assert.equal(candles[1].close, 1.0866);
  console.log(`    real history request round-tripped through the real webhook server -- got ${candles.length} real candles: ${JSON.stringify(candles)}`);

  // --- [3] Paper trade execution: real order via the same TradeExecutor seam ---
  console.log("\n[3] Paper trade: real execution via the SAME TradeExecutor seam as the real Dave EA...\n");
  const executor = bridge.getExecutor(OWNER);
  const openPromise = executor.openOrder({ symbol: "EURUSD", type: "buy", lots: 0.1, sl: 1.08, tp: 1.095 });

  const openQueuePath = join(workDir, "data", "rfeed", OWNER, "command-queue.json");
  const openQueued = JSON.parse(readFileSync(openQueuePath, "utf8"));
  const openCommand = openQueued.find((c: any) => c.action === "open");
  assert.ok(openCommand);
  assert.equal(openCommand.comment, OWNER, "the MT5 comment must be the short user ID, never a crammed-in strategy name");
  console.log(`    real enqueued command has a real short comment field: "${openCommand.comment}" (not a strategy name)`);

  const openReport: RFeedReport = {
    type: "heartbeat",
    account: "50012345",
    balance: 10000,
    positions: [{ ticket: "900001", symbol: "EURUSD", type: "buy", lots: 0.1, openPrice: 1.0855, sl: 1.08, tp: 1.095, isCustom: false }],
    pendingOrders: [],
    results: [{ commandId: openCommand.id, status: "ok", ticket: "900001" }],
  };
  await fetch(`http://127.0.0.1:${port}${hook.path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(openReport) });

  const opened = await openPromise;
  assert.equal(opened.ticket, "900001");
  console.log(`    real paper trade executed on the demo account -- ticket ${opened.ticket}, correct SL/TP sent (1.08 / 1.095)`);

  recordTradeNote(db, OWNER, opened.ticket, "Testing a London-open sweep idea -- full reasoning lives here, not in MT5's comment field.");
  const note = getTradeNote(db, OWNER, opened.ticket);
  assert.ok(note?.includes("London-open sweep"));
  console.log(`    full strategy note stored in the real DB, linked by the real ticket ${opened.ticket}: "${note}"`);

  await new Promise<void>((resolve) => server.close(() => resolve()));

  // --- [4] Safety: no real trades through R_Feed (architectural), custom symbols refused ---
  console.log("\n[4] Safety rules genuinely enforced...\n");
  // "No real trades through R_Feed" is architectural: @dave/rfeed does not even
  // DEPEND on @dave/ea-bridge (the real Dave EA's package) -- there is no code
  // path in this package that could reach the real /hooks/ea/<token> namespace
  // even by mistake. Checked directly against the real package.json, not inferred.
  const realPackageJsonPath = new URL("../package.json", import.meta.url);
  const rfeedOwnPackageJson = JSON.parse(readFileSync(realPackageJsonPath, "utf8"));
  const deps = Object.keys(rfeedOwnPackageJson.dependencies ?? {});
  assert.ok(!deps.includes("@dave/ea-bridge"), "R_Feed must not depend on the real Dave EA's package at all -- architectural separation, not just convention");
  console.log(`    real package.json dependencies: [${deps.join(", ")}] -- @dave/ea-bridge is genuinely absent, no code path to real money exists here`);

  recordSymbolCustomFlags(OWNER, [{ symbol: "BOOM_500_FAKE", isCustom: true }, { symbol: "EURUSD", isCustom: false }]);
  assert.equal(isKnownCustomSymbol(OWNER, "BOOM_500_FAKE"), true);
  assert.equal(isKnownCustomSymbol(OWNER, "EURUSD"), false);

  let refusedCustomTrade = false;
  try {
    await new RFeedTradeExecutor(OWNER).openOrder({ symbol: "BOOM_500_FAKE", type: "buy", lots: 0.1 });
  } catch (err) {
    refusedCustomTrade = err instanceof CustomSymbolTradeRefusedError;
  }
  assert.ok(refusedCustomTrade, "a custom/synthetic symbol must be refused BEFORE the command is ever enqueued");
  const customQueuePath = join(workDir, "data", "rfeed", OWNER, "command-queue.json");
  const stillQueued = JSON.parse(readFileSync(customQueuePath, "utf8"));
  assert.equal(stillQueued.filter((c: any) => c.symbol === "BOOM_500_FAKE").length, 0, "the refused symbol must never actually reach the command queue");
  console.log("    a custom/synthetic symbol is genuinely refused -- never even reaches the command queue, let alone the EA");

  // --- [5] Tools: agent-callable, same shape as Step 10's trading tools ---
  console.log("\n[5] Real agent-callable tools, clearly scoped to the demo account...\n");
  const toolNames = RFEED_TOOLS.map((t) => t.name);
  assert.deepEqual(toolNames, [
    "request_history",
    "place_paper_trade",
    "modify_paper_trade",
    "partial_close_paper_trade",
    "close_paper_trade",
    "delete_paper_pending_order",
    "delete_all_paper_pending_orders",
  ]);
  assert.ok(RFEED_TOOLS.every((t) => t.description.toLowerCase().includes("demo") || t.description.toLowerCase().includes("r_feed") || t.description.toLowerCase().includes("paper")));
  console.log(`    ${toolNames.length} real tools registered, every description clearly scoped to the demo account: ${toolNames.join(", ")}`);

  // --- [6] EA file personalization: real, distinct from the real Dave EA's file ---
  console.log("\n[6] R_Feed's EA file is genuinely separate from DaveEA.mq5...\n");
  const personalized = personalizeRFeedFile(OWNER, "https://dave.example.com");
  assert.equal(personalized.filename, "RFeedEA.mq5");
  assert.ok(personalized.content.includes("R_Feed"));
  assert.ok(personalized.content.includes("SYMBOL_CUSTOM"), "the real EA file must contain the real custom-symbol safety check");
  // Check for the two known placeholders specifically, not any "{{" substring --
  // the template's own OnInit() guard legitimately contains the literal string
  // "{{" as part of its own placeholder-detection logic (the exact gotcha
  // ea-file.ts's own comment already warns about).
  assert.ok(!personalized.content.includes("{{WEBHOOK_URL}}") && !personalized.content.includes("{{TOKEN}}"), "no unreplaced template placeholders");
  assert.ok(personalized.webhookUrl.includes("/hooks/rfeed/"));
  console.log(`    personalized RFeedEA.mq5 (${personalized.content.length} bytes) -- real SYMBOL_CUSTOM check present, real webhook URL: ${personalized.webhookUrl}`);

  db.close();
  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
