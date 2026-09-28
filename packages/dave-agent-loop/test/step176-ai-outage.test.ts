import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { DaveDatabase } from "@dave/db";
import type { Provider, CompletionRequest, CompletionResult } from "@dave/brain";
import type { TradeExecutor, OrderRequest } from "@dave/trading";
import { upsertGroup, setActiveGroup } from "@dave/trading";
import { getOrCreateEaWebhook, createEaWebhookServer, type EaCommand } from "@dave/ea-bridge";
import { runAutonomousTick } from "../src/autonomous-tick.js";
import { onEaRequest } from "@dave/ea-bridge";
import { activityAfter } from "../src/activity-bus.js";
import { activeAiOutage, describeAiFailure } from "../src/ai-outage.js";

/**
 * The trader: "it's just sending ea request like 6 or 7 times when the api credit ran out -- it
 * should just tell me".
 */
console.log("=== Step 176: out of AI credit -> no MT5 flood, told once ===\n");
const workDir = mkdtempSync(join(tmpdir(), "dave-ai-outage-"));
process.chdir(workDir);
process.env.DAVE_DATA_ROOT = workDir;
globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;

function startSimulatedEa(userId: string, price: { bid: number; ask: number; atr?: number }, dead: string[] = []) {
  const webhook = getOrCreateEaWebhook(userId);
  const server = createEaWebhookServer();
  let port = 0;
  const ready = new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => { port = (server.address() as { port: number }).port; resolve(); }));
  const postReport = (body: unknown): Promise<{ commands: EaCommand[] }> =>
    new Promise((resolve, reject) => {
      const json = JSON.stringify(body);
      const req = request(
        { hostname: "127.0.0.1", port, path: webhook.path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(json) } },
        (res) => { let data = ""; res.on("data", (c) => (data += c)); res.on("end", () => resolve(JSON.parse(data))); }
      );
      req.on("error", reject);
      req.write(json);
      req.end();
    });
  let running = true;
  const loop = (async () => {
    await ready;
    while (running) {
      const heartbeat = { type: "heartbeat", account: "123", balance: 1000, positions: [], pendingOrders: [] };
      const resp = await postReport(heartbeat).catch(() => ({ commands: [] as EaCommand[] }));
      for (const cmd of resp.commands) {
        if (cmd.action !== "analyze") continue;
        const isDead = dead.includes(String((cmd as { symbol?: string }).symbol));
        await postReport({ ...heartbeat, results: [isDead ? { commandId: cmd.id, status: "error", message: `not enough real history loaded yet for ${(cmd as { symbol?: string }).symbol}` } : { commandId: cmd.id, status: "ok", data: { price, volatility: { atr: price.atr ?? 0.001 } } }] }).catch(() => undefined);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  })();
  return { stop: async () => { running = false; await loop; await ready; server.close(); } };
}

function makeExecutor(): { executor: TradeExecutor; placedOrders: OrderRequest[] } {
  const placedOrders: OrderRequest[] = [];
  const executor: TradeExecutor = {
    openOrder: async (order) => { placedOrders.push(order); return { ticket: `T${placedOrders.length}` }; },
    modifyOrder: async () => undefined,
    closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
    deletePendingOrder: async () => undefined,
    listOpenPositions: async () => [],
    listPendingOrders: async () => [],
  };
  return { executor, placedOrders };
}



console.log("[1] A credit failure is named as one");
assert.match(describeAiFailure(new Error("402: Insufficient credits on your account")), /out of credit/);
assert.match(describeAiFailure(new Error("401 invalid api key")), /key was refused/);
console.log("   ✓\n");

console.log("[2] First scan fails at the model -> the next scans ask MT5 for nothing");
const OWNER = "broke";
upsertGroup(OWNER, { id: "g", name: "G", symbols: ["XAUUSD", "EURUSD"] });
setActiveGroup(OWNER, "g");
const ea = startSimulatedEa(OWNER, { bid: 2650, ask: 2650.2, atr: 3 });
const { executor } = makeExecutor();
let calls = 0;
const provider: Provider = { name: "mock", generate: async (): Promise<CompletionResult> => { calls++; throw new Error("402 Payment Required: insufficient credits"); } };
const db = new DaveDatabase(join(workDir, "dave.db"));
let eaRequests = 0;
onEaRequest((e) => { if (e.userId === OWNER) eaRequests++; });
await runAutonomousTick({ userId: OWNER, db, executor, provider }).catch(() => undefined);
const firstScan = eaRequests;
assert.ok(firstScan >= 1 && calls === 1);
assert.ok(activeAiOutage(OWNER));
for (let i = 0; i < 4; i++) await runAutonomousTick({ userId: OWNER, db, executor, provider }).catch(() => undefined);
assert.equal(eaRequests, firstScan, "no more MT5 requests while the AI is down");
assert.equal(calls, 1, "no more model calls either");
const alerts = activityAfter(OWNER, 0, ["background"]).filter((e) => e.kind === "alert" && String(e.data.text).includes("out of credit"));
assert.equal(alerts.length, 1, "told once");
await ea.stop();
console.log(`   ✓ (${firstScan} MT5 requests on the first scan, 0 after)\n`);
console.log("All Step 176 checks passed.");
process.exit(0);
