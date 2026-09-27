import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { DaveDatabase } from "@dave/db";
import type { Provider, CompletionRequest, CompletionResult } from "@dave/brain";
import type { TradeExecutor, OrderRequest } from "@dave/trading";
import { upsertGroup, setActiveGroup, setMinRiskReward } from "@dave/trading";
import { getOrCreateEaWebhook, createEaWebhookServer, type EaCommand } from "@dave/ea-bridge";
import { runAutonomousTick } from "../src/autonomous-tick.js";

/**
 * The trader, pointing at the live trade logs: "you see the issue about the risk reward stuff".
 * The model worked out good levels in its reasoning but submitted old ones (or put a SELL's stop
 * below its entry), and the whole setup was thrown away. Now the refusal goes back once so it can
 * fix them -- and the hard gate still refuses anything that stays bad.
 */
console.log("=== Step 173: a refused stop/target gets one correction ===\n");
const workDir = mkdtempSync(join(tmpdir(), "dave-rr-repair-"));
process.chdir(workDir);
process.env.DAVE_DATA_ROOT = workDir;
globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;

function startSimulatedEa(userId: string, price: { bid: number; ask: number; atr?: number }) {
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
        await postReport({ ...heartbeat, results: [{ commandId: cmd.id, status: "ok", data: { price, volatility: { atr: price.atr ?? 0.001 } } }] }).catch(() => undefined);
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


function scripted(decisions: Record<string, unknown>[]) {
  const prompts: string[] = [];
  const provider: Provider = {
    name: "mock",
    generate: async (req: CompletionRequest): Promise<CompletionResult> => {
      prompts.push(String(req.messages.at(-1)?.content ?? ""));
      const d = decisions[Math.min(prompts.length - 1, decisions.length - 1)];
      return { text: "", provider: "mock", latencyMs: 1, toolCalls: [{ id: `t${prompts.length}`, name: "submit_trading_decision", arguments: d }] };
    },
  };
  return { provider, prompts };
}

const db = new DaveDatabase(join(workDir, "dave.db"));
const base = { symbol: "EURUSD", confidence: 80, reason: "sell the retest", lots: 0.1, strategyTag: "retest" };

console.log("[1] SELL with its stop BELOW the entry -> sent back -> corrected -> placed");
{
  const OWNER = "rr-fix";
  upsertGroup(OWNER, { id: "g", name: "G", symbols: ["EURUSD"] });
  setActiveGroup(OWNER, "g");
  setMinRiskReward(OWNER, 2);
  const ea = startSimulatedEa(OWNER, { bid: 1.1, ask: 1.1002, atr: 0.0005 });
  const { executor, placedOrders } = makeExecutor();
  const { provider, prompts } = scripted([
    { ...base, action: "SELL", sl: 1.09, tp: 1.08 },
    { ...base, action: "SELL", sl: 1.105, tp: 1.08 },
  ]);
  const outcome = await runAutonomousTick({ userId: OWNER, db, executor, provider });
  assert.equal(prompts.length, 2, "exactly one retry");
  assert.match(prompts[1], /REFUSED BEFORE REACHING THE BROKER: the stop loss \(1\.09\) is on the wrong side/);
  assert.equal(placedOrders.length, 1, "the corrected trade is placed");
  assert.deepEqual([placedOrders[0].type, placedOrders[0].sl, placedOrders[0].tp], ["sell", 1.105, 1.08]);
  assert.equal(outcome.action, "SELL");
  await ea.stop();
}
console.log("   ✓\n");

console.log("[2] Still below the floor after the retry -> refused, never placed, honest message");
{
  const OWNER = "rr-still-bad";
  upsertGroup(OWNER, { id: "g", name: "G", symbols: ["EURUSD"] });
  setActiveGroup(OWNER, "g");
  setMinRiskReward(OWNER, 2);
  const ea = startSimulatedEa(OWNER, { bid: 1.1, ask: 1.1002, atr: 0.0005 });
  const { executor, placedOrders } = makeExecutor();
  const { provider, prompts } = scripted([{ ...base, action: "SELL", sl: 1.11, tp: 1.095 }]);
  const outcome = await runAutonomousTick({ userId: OWNER, db, executor, provider });
  assert.equal(prompts.length, 2, "one retry, never a loop");
  assert.equal(placedOrders.length, 0);
  assert.match(outcome.message ?? "", /even after one correction/);
  await ea.stop();
}
console.log("   ✓\n");

console.log("[3] The retry answers SKIP -> nothing placed, no crash");
{
  const OWNER = "rr-skip";
  upsertGroup(OWNER, { id: "g", name: "G", symbols: ["EURUSD"] });
  setActiveGroup(OWNER, "g");
  setMinRiskReward(OWNER, 2);
  const ea = startSimulatedEa(OWNER, { bid: 1.1, ask: 1.1002, atr: 0.0005 });
  const { executor, placedOrders } = makeExecutor();
  const { provider } = scripted([{ ...base, action: "SELL", sl: 1.09, tp: 1.08 }, { action: "SKIP", reason: "no honest levels" }]);
  const outcome = await runAutonomousTick({ userId: OWNER, db, executor, provider });
  assert.equal(placedOrders.length, 0);
  assert.equal(outcome.action, "NONE");
  await ea.stop();
}
console.log("   ✓\n");

console.log("[4] Good levels first time -> no retry at all");
{
  const OWNER = "rr-good";
  upsertGroup(OWNER, { id: "g", name: "G", symbols: ["EURUSD"] });
  setActiveGroup(OWNER, "g");
  setMinRiskReward(OWNER, 2);
  const ea = startSimulatedEa(OWNER, { bid: 1.1, ask: 1.1002, atr: 0.0005 });
  const { executor, placedOrders } = makeExecutor();
  const { provider, prompts } = scripted([{ ...base, action: "SELL", sl: 1.105, tp: 1.08 }]);
  await runAutonomousTick({ userId: OWNER, db, executor, provider });
  assert.equal(prompts.length, 1);
  assert.equal(placedOrders.length, 1);
  await ea.stop();
}
console.log("   ✓\n");
console.log("All Step 173 checks passed.");
process.exit(0);
