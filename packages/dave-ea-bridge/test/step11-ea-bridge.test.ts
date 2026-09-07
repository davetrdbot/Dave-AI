import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { EaBridge, getOrCreateEaWebhook, peekQueue, getLastKnownAccountSnapshot, McpTradeExecutor, McpConnectionError } from "../src/index.js";

const DATA_DIR = join(process.cwd(), "data");
rmSync(DATA_DIR, { recursive: true, force: true });

console.log("=== Step 11 real proof: EA bridge + MCP alternative ===\n");
const USER_ID = "tg-847213";

// --- 11.1: real webhook contract, real HTTP round trip ---
console.log("[1] Real EA webhook: token generation, distinct from Step 4/12 namespaces...");
const hook = getOrCreateEaWebhook(USER_ID);
console.log(`    path: ${hook.path}`);
assert.match(hook.path, /^\/hooks\/ea\/DAVE-tg-847213-[0-9A-F]{8}$/, "real DAVE-<userId>-<suffix> token format, per the user's explicit revocable-token ask");

const events: { manualCloses: any[]; results: any[] } = { manualCloses: [], results: [] };
const bridge = new EaBridge({
  onManualClose: (userId, position) => events.manualCloses.push({ userId, position }),
  onCommandResult: (userId, result) => events.results.push({ userId, result }),
});
const server = bridge.createServer();
await new Promise<void>((resolve) => server.listen(0, resolve));
const address = server.address();
if (typeof address !== "object" || !address) throw new Error("bind failed");
const base = `http://127.0.0.1:${address.port}`;

console.log("\n[2] EA sends a real heartbeat with one open position -- gets an empty command list back...");
const res1 = await fetch(`${base}${hook.path}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    type: "heartbeat",
    account: "12345678",
    balance: 10000,
    equity: 10120,
    margin: 250,
    freeMargin: 9870,
    positions: [{ ticket: "T1", symbol: "EURUSD", type: "buy", lots: 0.5, openPrice: 1.085 }],
    pendingOrders: [],
  }),
});
const json1 = await res1.json();
console.log(`    response: ${JSON.stringify(json1)}`);
assert.equal(res1.status, 200);
assert.deepEqual(json1.commands, []);

// Real gap fixed: balance/equity/margin/freeMargin were reported by the EA
// but never actually persisted anywhere -- nothing could read them back.
console.log("\n[2b] Real gap fixed: balance/equity/margin/freeMargin are now genuinely persisted...");
const snapshot = getLastKnownAccountSnapshot(USER_ID);
console.log(`    real account snapshot read back: ${JSON.stringify(snapshot)}`);
assert.equal(snapshot?.balance, 10000);
assert.equal(snapshot?.equity, 10120);
assert.equal(snapshot?.margin, 250);
assert.equal(snapshot?.freeMargin, 9870);

// --- 11.1: the executor's openOrder() enqueues a real command, waits for a real result ---
console.log("\n[3] EaTradeExecutor.openOrder() enqueues a real command and awaits the EA's real result...");
const executor = bridge.getExecutor(USER_ID);
const openPromise = executor.openOrder({ symbol: "XAUUSD", type: "buy", lots: 0.1 });

// Real proof the command is genuinely queued, not silently dropped:
const queued = peekQueue(USER_ID);
console.log(`    queued command (before the EA ever picks it up): ${JSON.stringify(queued)}`);
assert.equal(queued.length, 1);
assert.equal(queued[0].action, "open");
const commandId = queued[0].id;

console.log("\n[4] The EA's NEXT heartbeat picks up the queued command in the response, then later reports its result...");
const res2 = await fetch(`${base}${hook.path}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ type: "heartbeat", account: "12345678", balance: 10000, positions: [{ ticket: "T1", symbol: "EURUSD", type: "buy", lots: 0.5, openPrice: 1.085 }], pendingOrders: [] }),
});
const json2 = await res2.json();
console.log(`    response carried the queued command back to the EA: ${JSON.stringify(json2)}`);
assert.equal(json2.commands.length, 1);
assert.equal(json2.commands[0].id, commandId);
assert.equal(peekQueue(USER_ID).length, 0, "the queue must be drained once handed back, not double-delivered");

console.log("\n[5] EA reports the result on its next report -- openOrder()'s promise resolves for real...");
const res3 = await fetch(`${base}${hook.path}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    type: "heartbeat",
    account: "12345678",
    balance: 10000,
    positions: [
      { ticket: "T1", symbol: "EURUSD", type: "buy", lots: 0.5, openPrice: 1.085 },
      { ticket: "T2", symbol: "XAUUSD", type: "buy", lots: 0.1, openPrice: 2650 },
    ],
    pendingOrders: [],
    results: [{ commandId, status: "ok", ticket: "T2" }],
  }),
});
assert.equal(res3.status, 200);
const openResult = await openPromise;
console.log(`    openOrder() resolved with: ${JSON.stringify(openResult)}`);
assert.equal(openResult.ticket, "T2");

// --- 11.1: manual close detection ---
console.log("\n[6] Manual close detection: T1 disappears WITHOUT Dave closing it -> reported as manual...");
await fetch(`${base}${hook.path}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    type: "heartbeat",
    account: "12345678",
    balance: 10000,
    positions: [{ ticket: "T2", symbol: "XAUUSD", type: "buy", lots: 0.1, openPrice: 2650 }], // T1 gone, no close command was ever sent for it
    pendingOrders: [],
  }),
});
console.log(`    manual closes detected: ${JSON.stringify(events.manualCloses)}`);
assert.equal(events.manualCloses.length, 1);
assert.equal(events.manualCloses[0].position.ticket, "T1");

console.log("\n[7] A Dave-INITIATED close must NOT be misreported as manual...");
const closePromise = executor.closePosition("T2");
const closeQueued = peekQueue(USER_ID);
const closeCommandId = closeQueued[0].id;
// EA picks up the close command...
await fetch(`${base}${hook.path}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ type: "heartbeat", account: "12345678", balance: 10000, positions: [{ ticket: "T2", symbol: "XAUUSD", type: "buy", lots: 0.1, openPrice: 2650 }], pendingOrders: [] }),
});
// ...executes it, and reports T2 gone AND the result in the SAME report:
await fetch(`${base}${hook.path}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    type: "heartbeat",
    account: "12345678",
    balance: 10000,
    positions: [], // T2 gone -- but Dave closed it on purpose
    pendingOrders: [],
    results: [{ commandId: closeCommandId, status: "ok" }],
  }),
});
await closePromise;
console.log(`    manual closes after Dave's own close: still ${events.manualCloses.length} (unchanged -- T2's disappearance correctly NOT flagged)`);
assert.equal(events.manualCloses.length, 1, "must still be exactly the T1 manual close from step 6, nothing new");

await new Promise<void>((resolve) => server.close(() => resolve()));

// --- 11.3: MCP trade placement alternative -- real connection attempt ---
console.log("\n[8] MCP trade placement alternative -- real connection attempt (no server exists here)...");
const mcpExecutor = new McpTradeExecutor({ serverUrl: "http://127.0.0.1:1/mcp" }); // nothing listens on port 1
let mcpError: McpConnectionError | undefined;
try {
  await mcpExecutor.connect();
} catch (err) {
  if (err instanceof McpConnectionError) mcpError = err;
}
console.log(`    real connection attempt result: ${mcpError?.message}`);
assert.ok(mcpError, "a real MCP connection attempt against an unreachable server must fail with a real, typed error");

let calledWithoutConnect = false;
try {
  await mcpExecutor.openOrder({ symbol: "EURUSD", type: "buy", lots: 0.1 });
} catch {
  calledWithoutConnect = true;
}
assert.equal(calledWithoutConnect, true, "must refuse to place a trade through a connection that never succeeded");

rmSync(DATA_DIR, { recursive: true, force: true });

console.log("\n=== ALL ASSERTIONS PASSED ===");
