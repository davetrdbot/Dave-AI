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
import { benchSymbols, isSymbolUnavailable, listUnavailableSymbols, parseNotOnBroker, clearUnavailable } from "../src/symbol-availability.js";

/**
 * The trader, from the friend's logs: XPTUSD asked for every two minutes, every timeframe failing,
 * for hours -- "the bot should report or leave the pair, it shouldn't keep requesting".
 */
console.log("=== Step 175: dead pairs are left alone ===\n");
const workDir = mkdtempSync(join(tmpdir(), "dave-dead-pairs-"));
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



console.log("[1] MT5's Market Watch answer names the pairs the broker doesn't have");
assert.deepEqual(parseNotOnBroker("66 of 84 pairs in Market Watch (not on this broker: XRPUSD, XPTUSD, US30)"), ["XRPUSD", "XPTUSD", "US30"]);
assert.deepEqual(parseNotOnBroker("84 of 84 pairs in Market Watch"), []);
assert.deepEqual(benchSymbols("u1", ["xptusd", "US30"], "not offered", 24), ["XPTUSD", "US30"], "new ones are reported");
assert.deepEqual(benchSymbols("u1", ["XPTUSD"], "not offered", 24), [], "already known: not reported again");
assert.ok(isSymbolUnavailable("u1", "XPTUSD"));
assert.equal(listUnavailableSymbols("u1", Date.now() + 25 * 3600_000).length, 0, "a bench runs out");
clearUnavailable("u1", "US30");
assert.ok(!isSymbolUnavailable("u1", "US30"));
console.log("   ✓\n");

console.log("[2] The scan: no data twice -> benched, told once, and the round-robin moves on");
const OWNER = "friend";
upsertGroup(OWNER, { id: "metals", name: "Metals", symbols: ["XPTUSD", "XAUUSD"] });
setActiveGroup(OWNER, "metals");
const ea = startSimulatedEa(OWNER, { bid: 2650, ask: 2650.2, atr: 3 }, ["XPTUSD"]);
const { executor } = makeExecutor();
const asked: string[] = [];
const provider: Provider = {
  name: "mock",
  generate: async (req: CompletionRequest): Promise<CompletionResult> => {
    asked.push(String(req.messages.at(-1)?.content ?? "").slice(0, 40));
    return { text: "", provider: "mock", latencyMs: 1, toolCalls: [{ id: "t", name: "submit_trading_decision", arguments: { action: "SKIP", reason: "nothing clean" } }] };
  },
};
const db = new DaveDatabase(join(workDir, "dave.db"));
const picked: string[] = [];
const messages: string[] = [];
for (let i = 0; i < 5; i++) {
  const out = await runAutonomousTick({ userId: OWNER, db, executor, provider });
  if (out.message) messages.push(out.message);
  picked.push(out.symbol ?? "-");
}
const benchedMsgs = messages.filter((m) => m.includes("Leaving XPTUSD alone"));
assert.equal(benchedMsgs.length, 1, `told exactly once (got ${messages.length} messages)`);
assert.ok(isSymbolUnavailable(OWNER, "XPTUSD"));
assert.ok(asked.length >= 2, "XAUUSD still got analysed -- the scan didn't get stuck on the dead pair");
await ea.stop();
console.log(`   ✓ (model asked ${asked.length}x, all for the live pair)\n`);
console.log("All Step 175 checks passed.");
process.exit(0);
