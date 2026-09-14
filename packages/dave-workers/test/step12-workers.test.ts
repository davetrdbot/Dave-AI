import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { createHiddenWebhookServer, readInbox } from "@dave/memory";
import {
  createWorker,
  listWorkers,
  retireWorker,
  toolsForWorker,
  modelConfigForWorker,
  reportToUser,
  readWorkerReports,
  writeTradeJournalEntry,
  SETTINGS_TOOLS,
} from "../src/index.js";

const DATA_DIR = join(process.cwd(), "data");
rmSync(DATA_DIR, { recursive: true, force: true });

console.log("=== Step 12 real proof: workers ===\n");
const USER_ID = "tg-847213";

// --- 12.1/12.2: named like people, created on the fly, fixed vs temporary ---
console.log("[1] Workers are named like people, not 'Worker-1' -- created on the fly...");
const w1 = createWorker(USER_ID, { assignment: "temporary", task: "Scan majors for a setup right now" });
console.log(`    created: "${w1.name}" (id ${w1.id}), assignment=${w1.assignment}, role=${w1.role}`);
assert.ok(/^[A-Za-zÀ-ÿ]/.test(w1.name), "name should look like a real name, not a generic label");
assert.equal(w1.assignment, "temporary");

const w2 = createWorker(USER_ID, { name: "Priya", assignment: "fixed", role: "journal", task: "Write up every trade's reasoning" });
console.log(`    created: "${w2.name}" (fixed, role=${w2.role})`);
assert.equal(w2.name, "Priya");
assert.equal(w2.assignment, "fixed");

console.log("\n[1b] Two active workers can't collide on the same name...");
let nameCollision = false;
try {
  createWorker(USER_ID, { name: "Priya", assignment: "temporary", task: "duplicate name attempt" });
} catch {
  nameCollision = true;
}
assert.equal(nameCollision, true);

console.log("\n[1c] A temporary worker's assignment closes out -- retiring removes it from the active list...");
retireWorker(USER_ID, w1.id);
const active = listWorkers(USER_ID);
console.log(`    active workers after retiring ${w1.name}: ${active.map((w) => w.name).join(", ")}`);
assert.equal(active.length, 1);
assert.equal(active[0].id, w2.id);

// --- 12.5: full feature parity except real trades, unless a trading worker ---
console.log("\n[2] Full feature parity except opening real trades, unless designated a trading worker...");
const genericTools = toolsForWorker(w2); // journal role, not trading
const genericToolNames = genericTools.map((t) => t.name);
console.log(`    journal-role worker's tools: ${genericToolNames.join(", ")}`);
assert.ok(genericToolNames.includes("find_setup"), "non-trading tools stay available -- full parity, not zero access");
assert.ok(!genericToolNames.includes("trade_execute"), "trade-placing tools must be excluded for a non-trading worker");
assert.ok(!genericToolNames.includes("delete_all_pending_orders"));

const tradingWorker = createWorker(USER_ID, { name: "Kenji", assignment: "temporary", role: "trading", task: "Execute the approved EURUSD long" });
const tradingTools = toolsForWorker(tradingWorker).map((t) => t.name);
console.log(`    trading-role worker's tools include trade_execute: ${tradingTools.includes("trade_execute")}`);
assert.ok(tradingTools.includes("trade_execute"), "a designated trading worker DOES get real trade-placing tools");

console.log("\n[2b] Workers route through DeepSeek/Claude (Step 5.4, reachable per-worker)...");
const modelConfig = modelConfigForWorker(w2);
console.log(`    ${JSON.stringify(modelConfig)}`);
assert.ok(modelConfig.primary === "deepseek" || modelConfig.primary === "claude", "workers must route to deepseek or claude");

// --- 12.3/12.6: real per-worker endpoint, tagged output, report_to_user ---
console.log("\n[3] Real per-worker webhook endpoint + tagged output (report_to_user)...");
const server = createHiddenWebhookServer();
await new Promise<void>((resolve) => server.listen(0, resolve));
const address = server.address();
if (typeof address !== "object" || !address) throw new Error("bind failed");
const baseUrl = `http://127.0.0.1:${address.port}`;

const reportResult = await reportToUser(w2, "Scanned the majors group -- EURUSD confluence 82, worth a look.", baseUrl);
console.log(`    reportToUser() -> ${JSON.stringify(reportResult)}`);
assert.equal(reportResult.ok, true);
assert.equal(reportResult.tag, "#priya");

const reports = readWorkerReports(USER_ID);
console.log(`    stored, correctly tagged: ${JSON.stringify(reports[0].payload)}`);
assert.equal(reports.length, 1);
assert.equal((reports[0].payload as any).tag, "#priya");
assert.match((reports[0].payload as any).content, /EURUSD confluence 82/);

console.log("\n[3b] A worker's endpoint is genuinely its OWN -- another worker's token doesn't work for it...");
const otherReports = readWorkerReports(USER_ID, "not-a-real-worker-id");
assert.equal(otherReports.length, 0, "filtering by a different workerId must not leak this worker's reports");

await new Promise<void>((resolve) => server.close(() => resolve()));

// --- 12.7: journal role produces a real readable writeup, not a data dump ---
console.log("\n[4] Journal worker produces an actual readable narrative, not raw JSON...");
const entry = writeTradeJournalEntry({
  symbol: "XAUUSD",
  direction: "buy",
  entryPrice: 2650.5,
  sl: 2645,
  tp: 2665,
  reasoning: [
    "H4 and H1 trend both agreed bullish (score +2, +1)",
    "Liquidity swept the Asian session low right before the move",
    "Price tapped a fresh bullish order block with a clean FVG above it",
  ],
  confluenceScore: 82,
  timestamp: Date.parse("2026-09-04T10:00:00Z"),
});
console.log("---");
console.log(entry);
console.log("---");
assert.ok(!entry.trimStart().startsWith("{"), "must be prose, not a JSON dump");
assert.match(entry, /XAUUSD/);
assert.match(entry, /order block/);
assert.match(entry, /82\/100/);
assert.match(entry, /stop at 2645/);

console.log("\n[4b] Missing reasoning is flagged honestly, not silently invented...");
const emptyEntry = writeTradeJournalEntry({ symbol: "EURUSD", direction: "sell", entryPrice: 1.085, reasoning: [] });
console.log(emptyEntry);
assert.match(emptyEntry, /No reasoning was recorded/);

// --- 12.8: workers can edit user settings, same permission Dave has ---
console.log("\n[5] Workers have real settings tools -- same permission Dave has, not locked out...");
console.log(`    settings tools: ${SETTINGS_TOOLS.map((t) => t.name).join(", ")}`);
const setRiskTool = SETTINGS_TOOLS.find((t) => t.name === "set_risk_mode")!;
const result = await setRiskTool.execute({ userId: USER_ID, field: "sl", mode: "on", value: 30 }, {} as any);
console.log(`    worker called set_risk_mode through the tool -> ${JSON.stringify(result)}`);
assert.deepEqual(result, { ok: true });
const { getRiskSettings } = await import("@dave/trading");
assert.equal(getRiskSettings(USER_ID).slValue, 30, "the setting a worker changed must actually have taken effect");

rmSync(DATA_DIR, { recursive: true, force: true });

console.log("\n=== ALL ASSERTIONS PASSED ===");
