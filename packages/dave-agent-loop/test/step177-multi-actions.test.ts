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
import { coerceTickActions } from "../src/tick-actions.js";

/**
 * The trader: "mode 2 -- the agent should be able to call 2 tools and more at the same time, e.g.
 * get candles AND put breakeven AND get volatility".
 */
console.log("=== Step 177: several actions in one scan ===\n");
const workDir = mkdtempSync(join(tmpdir(), "dave-multi-"));
process.chdir(workDir);
process.env.DAVE_DATA_ROOT = workDir;
globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;

function startSimulatedEa(userId: string, price: { bid: number; ask: number; atr?: number }, dead: string[] = [], positions: unknown[] = [], seen: string[] = []) {
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
      const heartbeat = { type: "heartbeat", account: "123", balance: 1000, positions, pendingOrders: [] };
      const resp = await postReport(heartbeat).catch(() => ({ commands: [] as EaCommand[] }));
      for (const cmd of resp.commands) {
        if (cmd.action !== "analyze") continue;
        seen.push(`${(cmd as { endpoint?: string }).endpoint}:${(cmd as { symbol?: string }).symbol}:${(cmd as { timeframe?: string }).timeframe}`);
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




console.log("[1] Malformed items are dropped, good ones kept");
const parsed = coerceTickActions([{ type: "breakeven", ticket: "#9" }, { type: "GET", endpoint: "get_volatility", timeframe: "h1" }, { type: "GET", endpoint: "nonsense" }, { type: "MODIFY", ticket: "3" }, "junk"]);
assert.deepEqual(parsed, [{ type: "BREAKEVEN", ticket: "9", offset: undefined }, { type: "GET", endpoint: "volatility", symbol: undefined, timeframe: "H1" }]);
console.log("   ✓\n");

console.log("[2] One decision: breakeven + candles + volatility -> both reads fetched, stop moved, then Dave decides again");
const OWNER = "multi";
upsertGroup(OWNER, { id: "g", name: "G", symbols: ["EURUSD"] });
setActiveGroup(OWNER, "g");
const seen: string[] = [];
const ea = startSimulatedEa(OWNER, { bid: 1.1, ask: 1.1001 }, [], [{ ticket: "501", symbol: "XAUUSD", type: "buy", lots: 0.1, openPrice: 2600, currentPrice: 2630, sl: 2580, tp: 2700 }], seen);
await new Promise((r) => setTimeout(r, 150));
const modifies: { ticket: string; changes: unknown }[] = [];
const { executor } = makeExecutor();
executor.modifyOrder = async (ticket, changes) => { modifies.push({ ticket, changes }); };
const prompts: string[] = [];
const decisions: Record<string, unknown>[] = [
  { action: "SKIP", reason: "need a closer look", confidence: 10, actions: [{ type: "BREAKEVEN", ticket: "501" }, { type: "GET", endpoint: "candles", symbol: "XAUUSD", timeframe: "M15" }, { type: "GET", endpoint: "volatility" }] },
  { action: "SKIP", reason: "gold safe at breakeven, EURUSD quiet", confidence: 20, actions: [{ type: "GET", endpoint: "trend" }] },
];
let i = 0;
const provider: Provider = {
  name: "mock",
  generate: async (req: CompletionRequest): Promise<CompletionResult> => {
    prompts.push(String(req.messages[req.messages.length - 1].content));
    const args = decisions[Math.min(i++, decisions.length - 1)];
    return { text: "", provider: "claude", latencyMs: 1, toolCalls: [{ id: `c${i}`, name: req.tools?.[0]?.name ?? "submit_trading_decision", arguments: args }] };
  },
};
const db = new DaveDatabase(join(workDir, "dave.db"));
const out = await runAutonomousTick({ userId: OWNER, db, executor, provider });
await ea.stop();
assert.equal(i, 2, "decided exactly twice -- one gather round, no loop");
assert.deepEqual(modifies, [{ ticket: "501", changes: { sl: 2600 } }], "breakeven moved the stop to the entry");
assert.ok(seen.some((s) => s.startsWith("candles:XAUUSD:M15")), `candles fetched: ${seen.join(" ")}`);
assert.ok(seen.some((s) => s.startsWith("volatility:EURUSD:M5")), `volatility fetched for the scanned pair: ${seen.join(" ")}`);
assert.ok(!seen.some((s) => s.startsWith("trend:")), "a GET on the second decision is ignored");
assert.match(prompts[1], /DATA YOU ASKED FOR \(2 fetched/);
assert.ok(out.notable && /breakeven 2600/.test(out.message ?? ""), `trader told: ${out.message}`);
console.log(`   ✓ (${out.message?.split("\n").join(" | ")})\n`);
console.log("All Step 177 checks passed.");
process.exit(0);
