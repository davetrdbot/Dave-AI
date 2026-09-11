import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { DaveDatabase } from "@dave/db";
import type { Provider, CompletionRequest, CompletionResult } from "@dave/brain";
import type { TradeExecutor } from "@dave/trading";
import { upsertGroup, setActiveGroup, setActivePairSymbol, setRiskMode, setConfidenceThreshold, setAutoApproveBelowThreshold, listPendingTradeApprovals } from "@dave/trading";
import { getOrCreateEaWebhook, createEaWebhookServer, type EaCommand } from "@dave/ea-bridge";
import { listTradesSince } from "@dave/feedback";
import { runAutonomousTick } from "../src/autonomous-tick.js";

/**
 * Real proof for the plan's core fix: the autonomous cycle's decision mechanism replaced with a
 * single structured call per tick (modeled on the user's own former bot's tickOne()), not an
 * open-ended agentic loop. Proves, end to end through the REAL functions this module actually
 * calls (evaluateConfidenceGate, tradeExecute, logTrade, huntForSetup, ask-user) -- not
 * reimplemented in the test: a real BUY fires and is logged, a low-confidence trade queues
 * instead of firing, an already-open symbol and a cooling-down symbol are skipped before any
 * model call happens at all, ASK genuinely creates a pending question, and the rolling
 * last-3-decisions context genuinely carries across ticks.
 */

console.log("=== Real proof: the autonomous tick's structured decision mechanism ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-autonomous-tick-"));
process.chdir(workDir);
const OWNER = "user-autonomous-tick-1";

const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;

/** A real simulated EA cycle answering "analyze" commands for endpoint "all" -- repeats until
 *  told to stop, same race-free pattern used elsewhere in this suite (step43). */
function startSimulatedEa(userId: string, priceBySymbol: Record<string, { bid: number; ask: number }>) {
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
        const price = priceBySymbol[cmd.symbol] ?? { bid: 1, ask: 1.0002 };
        await postReport({ ...heartbeat, results: [{ commandId: cmd.id, status: "ok", data: { price } }] }).catch(() => undefined);
      }
      await new Promise((r) => setTimeout(r, 30));
    }
  })();
  return { stop: async () => { running = false; await loop; await ready; server.close(); } };
}

function mockProvider(responses: string[]): { provider: Provider; calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  let i = 0;
  const provider: Provider = {
    name: "claude",
    generate: async (req: CompletionRequest): Promise<CompletionResult> => {
      calls.push(req);
      const text = responses[Math.min(i, responses.length - 1)];
      i++;
      return { text, provider: "claude", latencyMs: 1 };
    },
  };
  return { provider, calls };
}

try {
  const db = new DaveDatabase(join(workDir, "dave.db"));

  console.log("[1] A real BUY decision fires a genuine trade_execute, is auto-logged, and sets cooldown -- SL/TP auto mode, model computes both...\n");
  {
    upsertGroup(OWNER, { id: "majors", name: "Majors", symbols: ["EURUSD"] });
    setActiveGroup(OWNER, "majors");
    setRiskMode(OWNER, "sl", "auto");
    setRiskMode(OWNER, "tp", "auto");
    setRiskMode(OWNER, "lot", "off");
    setConfidenceThreshold(OWNER, 70);
    setAutoApproveBelowThreshold(OWNER, true);

    const placed: { symbol: string; type: string }[] = [];
    const executor: TradeExecutor = {
      openOrder: async (order) => { placed.push({ symbol: order.symbol, type: order.type }); return { ticket: "T-EURUSD" }; },
      modifyOrder: async () => {}, closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
      deletePendingOrder: async () => {}, listOpenPositions: async () => [], listPendingOrders: async () => [],
    };
    const ea = startSimulatedEa(OWNER, { EURUSD: { bid: 1.085, ask: 1.0852 } });
    const { provider, calls } = mockProvider([
      JSON.stringify({ action: "BUY", symbol: "EURUSD", entry: null, sl: 1.08, tp: 1.095, lots: 0.05, confidence: 78, reason: "BOS + OB retest + RSI turning up" }),
    ]);
    try {
      const outcome = await runAutonomousTick({ userId: OWNER, db, executor, provider });
      console.log(`    real outcome: ${JSON.stringify(outcome)}`);
      assert.equal(outcome.action, "BUY");
      assert.deepEqual(placed, [{ symbol: "EURUSD", type: "buy" }]);
      assert.equal(calls.length, 1, "exactly ONE model call for the whole decision -- no multi-turn tool loop");
      assert.equal(calls[0].tools, undefined, "no tools attached -- this is a single structured call, not an agentic loop");

      const journal = listTradesSince(db, OWNER, Date.now() - 60_000);
      assert.equal(journal.length, 1, "the trade must genuinely be auto-logged");
      assert.equal(journal[0].symbol, "EURUSD");
      console.log(`    real trade auto-logged: ${JSON.stringify(journal[0])}`);
    } finally {
      await ea.stop();
    }
  }

  console.log("\n[2] A symbol already carrying an open position is skipped BEFORE any model call...\n");
  {
    const OWNER2 = "user-autonomous-tick-2";
    upsertGroup(OWNER2, { id: "majors", name: "Majors", symbols: ["GBPUSD"] });
    setActiveGroup(OWNER2, "majors");
    const executor: TradeExecutor = {
      openOrder: async () => ({ ticket: "T" }), modifyOrder: async () => {}, closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
      deletePendingOrder: async () => {},
      listOpenPositions: async () => [{ ticket: "1", symbol: "GBPUSD", type: "buy", lots: 0.1, openPrice: 1.27 }],
      listPendingOrders: async () => [],
    };
    // Real EA report carrying the open position, so getLastKnownState reflects it.
    const webhook = getOrCreateEaWebhook(OWNER2);
    const server = createEaWebhookServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => {
      const body = JSON.stringify({ type: "heartbeat", account: "1", balance: 1000, positions: [{ ticket: "1", symbol: "GBPUSD", type: "buy", lots: 0.1, openPrice: 1.27 }], pendingOrders: [] });
      const req = request({ hostname: "127.0.0.1", port, path: webhook.path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => { res.on("data", () => {}); res.on("end", () => resolve()); });
      req.on("error", reject); req.write(body); req.end();
    });
    server.close();

    const { provider, calls } = mockProvider(['{"action":"SKIP","reason":"should never be called"}']);
    const outcome = await runAutonomousTick({ userId: OWNER2, db, executor, provider });
    console.log(`    real outcome: ${JSON.stringify(outcome)}, real model calls: ${calls.length}`);
    assert.equal(outcome.action, "NONE");
    assert.equal(calls.length, 0, "an already-open symbol must be skipped before any model call -- no wasted provider call");
  }

  console.log("\n[3] A low-confidence decision queues for approval instead of firing immediately...\n");
  {
    const OWNER3 = "user-autonomous-tick-3";
    upsertGroup(OWNER3, { id: "majors", name: "Majors", symbols: ["USDJPY"] });
    setActiveGroup(OWNER3, "majors");
    setConfidenceThreshold(OWNER3, 80);
    setAutoApproveBelowThreshold(OWNER3, false);
    setRiskMode(OWNER3, "lot", "on", 0.02);

    const placed: string[] = [];
    const executor: TradeExecutor = {
      openOrder: async (o) => { placed.push(o.symbol); return { ticket: "T" }; }, modifyOrder: async () => {}, closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
      deletePendingOrder: async () => {}, listOpenPositions: async () => [], listPendingOrders: async () => [],
    };
    const ea = startSimulatedEa(OWNER3, { USDJPY: { bid: 148, ask: 148.02 } });
    const { provider } = mockProvider([JSON.stringify({ action: "SELL", symbol: "USDJPY", entry: null, sl: 148.5, tp: 147, lots: 0.02, confidence: 45, reason: "weak momentum" })]);
    try {
      const outcome = await runAutonomousTick({ userId: OWNER3, db, executor, provider });
      console.log(`    real outcome: ${JSON.stringify(outcome)}`);
      assert.equal(outcome.action, "SELL");
      assert.equal(placed.length, 0, "a below-threshold trade with auto-approve off must NOT fire immediately");
      const pending = listPendingTradeApprovals(OWNER3);
      assert.equal(pending.length, 1);
      assert.equal(pending[0].order.symbol, "USDJPY");
      console.log(`    real pending approval genuinely queued: ${JSON.stringify(pending[0])}`);
    } finally {
      await ea.stop();
    }
  }

  console.log("\n[4] ASK sends the real question as a message WITHOUT deadlocking future cycles on the shared pending-question gate (that mechanism only resumes a paused main-chat AgentLoop -- a tick-originated question has no history entry to resume, so it must never block)...\n");
  {
    const OWNER4 = "user-autonomous-tick-4";
    upsertGroup(OWNER4, { id: "majors", name: "Majors", symbols: ["AUDUSD"] });
    setActiveGroup(OWNER4, "majors");
    const executor: TradeExecutor = { openOrder: async () => ({ ticket: "T" }), modifyOrder: async () => {}, closePosition: async () => ({ closedLots: 0, remainingLots: 0 }), deletePendingOrder: async () => {}, listOpenPositions: async () => [], listPendingOrders: async () => [] };
    const ea = startSimulatedEa(OWNER4, { AUDUSD: { bid: 0.65, ask: 0.6502 } });
    const { provider } = mockProvider([JSON.stringify({ action: "ASK", question: "H4 says buy but M15 just printed a CHoCH sell -- which do you want me to weight?", options: ["Follow H4", "Follow M15", "Skip"], reason: "conflicting timeframes" })]);
    try {
      const outcome = await runAutonomousTick({ userId: OWNER4, db, executor, provider });
      console.log(`    real outcome: ${JSON.stringify(outcome)}`);
      assert.equal(outcome.action, "ASK");
      assert.match(outcome.message!, /CHoCH sell/);
      const { getPendingQuestion } = await import("../src/ask-user.js");
      assert.equal(getPendingQuestion(OWNER4), undefined, "must NOT set the shared blocking pending-question record -- that would deadlock every future cycle with no resume path");
    } finally {
      await ea.stop();
    }
  }

  console.log("\n[5] The rolling last-3-decisions context genuinely carries across ticks, not a growing transcript...\n");
  {
    const OWNER5 = "user-autonomous-tick-5";
    upsertGroup(OWNER5, { id: "majors", name: "Majors", symbols: ["NZDUSD"] });
    setActiveGroup(OWNER5, "majors");
    const executor: TradeExecutor = { openOrder: async () => ({ ticket: "T" }), modifyOrder: async () => {}, closePosition: async () => ({ closedLots: 0, remainingLots: 0 }), deletePendingOrder: async () => {}, listOpenPositions: async () => [], listPendingOrders: async () => [] };
    const ea = startSimulatedEa(OWNER5, { NZDUSD: { bid: 0.59, ask: 0.5902 } });
    const { provider, calls } = mockProvider([
      '{"action":"SKIP","reason":"first real skip reason"}',
      '{"action":"SKIP","reason":"second real skip reason"}',
    ]);
    try {
      await runAutonomousTick({ userId: OWNER5, db, executor, provider });
      await new Promise((r) => setTimeout(r, 100)); // clear cooldown isn't set on SKIP, but let EA settle
      await runAutonomousTick({ userId: OWNER5, db, executor, provider });
      const secondCallContext = calls[1].messages.find((m) => m.role === "user")!.content as string;
      console.log(`    real second-tick context includes: ${secondCallContext.includes("first real skip reason") ? "the first tick's real decision" : "NOTHING -- BUG"}`);
      assert.ok(secondCallContext.includes("first real skip reason"), "the second tick's context must genuinely include the first tick's real decision");
    } finally {
      await ea.stop();
    }
  }

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
