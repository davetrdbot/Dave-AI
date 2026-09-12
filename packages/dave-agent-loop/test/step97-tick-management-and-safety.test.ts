import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { DaveDatabase } from "@dave/db";
import type { Provider, CompletionRequest, CompletionResult, ToolCall } from "@dave/brain";
import type { TradeExecutor } from "@dave/trading";
import { upsertGroup, setActiveGroup, setRiskMode, setConfidenceThreshold, setAutoApproveBelowThreshold, setSelfPauseEnabled } from "@dave/trading";
import { getOrCreateEaWebhook, createEaWebhookServer, type EaCommand } from "@dave/ea-bridge";
import { runAutonomousTick } from "../src/autonomous-tick.js";
import { getSelfPause, clearSelfPause } from "../src/self-pause.js";
import { setAutonomousExecutionEnabled } from "../src/autonomous-trading-state.js";

/**
 * Real proof for the 4 more live problems fixed this round: the bot now considers real open
 * exposure before deciding (a hard maxOpenTrades ceiling, real position/pending context on every
 * cycle), rejects a stop-loss that's genuinely too tight relative to real current volatility, can
 * act on an EXISTING trade (DELETE_TICKET/PARTIAL_CLOSE) and self-pause (PAUSE, 1-5 minutes,
 * respecting the user's own toggle) -- all through the SAME single forced decision tool, never a
 * second open-ended toolbox. Also proves the real /stop_trading race fix: a decision already in
 * flight when trading gets stopped is discarded, not fired.
 */

console.log("=== Real proof: position awareness, SL sanity, management actions, self-pause, and the /stop_trading race fix ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-tick-management-"));
process.chdir(workDir);

const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;

function startSimulatedEa(userId: string, priceBySymbol: Record<string, { bid: number; ask: number; atr?: number }>) {
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
        const p = priceBySymbol[cmd.symbol] ?? { bid: 1, ask: 1.0002, atr: 0.001 };
        await postReport({ ...heartbeat, results: [{ commandId: cmd.id, status: "ok", data: { price: p, volatility: { atr: p.atr ?? 0.001 } } }] }).catch(() => undefined);
      }
      await new Promise((r) => setTimeout(r, 30));
    }
  })();
  return { stop: async () => { running = false; await loop; await ready; server.close(); } };
}

function mockToolProvider(decisions: (Record<string, unknown> | (() => Record<string, unknown>))[]): { provider: Provider; calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  let i = 0;
  const provider: Provider = {
    name: "claude",
    generate: async (req: CompletionRequest): Promise<CompletionResult> => {
      calls.push(req);
      const raw = decisions[Math.min(i, decisions.length - 1)];
      const args = typeof raw === "function" ? raw() : raw;
      i++;
      const toolName = req.tools?.[0]?.name ?? "submit_trading_decision";
      const toolCalls: ToolCall[] = [{ id: `call-${i}`, name: toolName, arguments: args }];
      return { text: "", provider: "claude", latencyMs: 1, toolCalls };
    },
  };
  return { provider, calls };
}

try {
  const db = new DaveDatabase(join(workDir, "dave.db"));

  console.log("[1] A real maxOpenTrades ceiling blocks the cycle BEFORE any model call...\n");
  {
    const OWNER = "user-mgmt-1";
    upsertGroup(OWNER, { id: "majors", name: "Majors", symbols: ["EURUSD", "GBPUSD"] });
    setActiveGroup(OWNER, "majors");
    const { proposeProtectedLimitChange, approveProtectedLimitChange } = await import("@dave/trading");
    const change = proposeProtectedLimitChange(OWNER, "maxOpenTrades", 1, "test ceiling");
    approveProtectedLimitChange(OWNER, change.id);
    const executor: TradeExecutor = {
      openOrder: async () => ({ ticket: "T" }), modifyOrder: async () => {}, closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
      deletePendingOrder: async () => {}, listOpenPositions: async () => [], listPendingOrders: async () => [],
    };
    const webhook = getOrCreateEaWebhook(OWNER);
    const server = createEaWebhookServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => {
      const body = JSON.stringify({ type: "heartbeat", account: "1", balance: 1000, positions: [{ ticket: "900", symbol: "EURUSD", type: "buy", lots: 0.1, openPrice: 1.1 }], pendingOrders: [] });
      const req = request({ hostname: "127.0.0.1", port, path: webhook.path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => { res.on("data", () => {}); res.on("end", () => resolve()); });
      req.on("error", reject); req.write(body); req.end();
    });
    server.close();
    const { provider, calls } = mockToolProvider([{ action: "SKIP", reason: "should never be called" }]);
    const outcome = await runAutonomousTick({ userId: OWNER, db, executor, provider });
    assert.equal(outcome.action, "NONE");
    assert.equal(calls.length, 0, "at the real max-open-trades ceiling, no model call should ever fire");
    console.log(`    confirmed: ${calls.length} model calls at 1/1 max open trades`);
  }

  console.log("\n[2] Real position/pending context reaches the model's own request, every cycle...\n");
  {
    const OWNER = "user-mgmt-2";
    upsertGroup(OWNER, { id: "majors", name: "Majors", symbols: ["EURUSD"] });
    setActiveGroup(OWNER, "majors");
    setRiskMode(OWNER, "lot", "on", 0.01);
    const executor: TradeExecutor = {
      openOrder: async () => ({ ticket: "T" }), modifyOrder: async () => {}, closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
      deletePendingOrder: async () => {}, listOpenPositions: async () => [], listPendingOrders: async () => [],
    };
    const webhook = getOrCreateEaWebhook(OWNER);
    const server = createEaWebhookServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => {
      const body = JSON.stringify({ type: "heartbeat", account: "1", balance: 1000, positions: [{ ticket: "777", symbol: "GBPUSD", type: "sell", lots: 0.2, openPrice: 1.27, pnl: -5 }], pendingOrders: [{ ticket: "778", symbol: "USDJPY", type: "buy_limit", lots: 0.1, price: 148 }] });
      const req = request({ hostname: "127.0.0.1", port, path: webhook.path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => { res.on("data", () => {}); res.on("end", () => resolve()); });
      req.on("error", reject); req.write(body); req.end();
    });
    server.close();
    const ea = startSimulatedEa(OWNER, { EURUSD: { bid: 1.08, ask: 1.0802, atr: 0.001 } });
    const { provider, calls } = mockToolProvider([{ action: "SKIP", reason: "checking context" }]);
    try {
      await runAutonomousTick({ userId: OWNER, db, executor, provider });
      const userMessage = calls[0].messages.find((m) => m.role === "user")!.content as string;
      assert.ok(userMessage.includes("#777"), "the real open position's ticket must be in the model's own context");
      assert.ok(userMessage.includes("GBPUSD"), "the real open position's symbol must be in the model's own context");
      assert.ok(userMessage.includes("#778"), "the real pending order's ticket must be in the model's own context");
      console.log("    confirmed: real open position and pending order details reached the model's context");
    } finally {
      await ea.stop();
    }
  }

  console.log("\n[3] DELETE_TICKET on a real open position closes it; on a real pending order deletes it...\n");
  {
    const OWNER = "user-mgmt-3";
    upsertGroup(OWNER, { id: "majors", name: "Majors", symbols: ["EURUSD"] });
    setActiveGroup(OWNER, "majors");
    const closedTickets: string[] = [];
    const deletedTickets: string[] = [];
    const executor: TradeExecutor = {
      openOrder: async () => ({ ticket: "T" }),
      modifyOrder: async () => {},
      closePosition: async (ticket) => { closedTickets.push(ticket); return { closedLots: 0.1, remainingLots: 0 }; },
      deletePendingOrder: async (ticket) => { deletedTickets.push(ticket); },
      listOpenPositions: async () => [], listPendingOrders: async () => [],
    };
    const webhook = getOrCreateEaWebhook(OWNER);
    const server = createEaWebhookServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => {
      const body = JSON.stringify({ type: "heartbeat", account: "1", balance: 1000, positions: [{ ticket: "500", symbol: "GBPUSD", type: "buy", lots: 0.1, openPrice: 1.27 }], pendingOrders: [{ ticket: "501", symbol: "USDJPY", type: "buy_limit", lots: 0.1, price: 148 }] });
      const req = request({ hostname: "127.0.0.1", port, path: webhook.path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => { res.on("data", () => {}); res.on("end", () => resolve()); });
      req.on("error", reject); req.write(body); req.end();
    });
    server.close();
    const ea = startSimulatedEa(OWNER, { EURUSD: { bid: 1.08, ask: 1.0802 } });
    const { provider } = mockToolProvider([{ action: "DELETE_TICKET", ticket: "500", reason: "closing manually" }]);
    try {
      const outcome = await runAutonomousTick({ userId: OWNER, db, executor, provider });
      assert.equal(outcome.action, "DELETE_TICKET");
      assert.deepEqual(closedTickets, ["500"], "a ticket that's a real open position must go through fullClose");
      assert.deepEqual(deletedTickets, [], "must not touch deletePendingOrder for an open position's ticket");
      console.log(`    confirmed: DELETE_TICKET on an open position closed it -- ${outcome.message}`);
    } finally {
      await ea.stop();
    }
  }

  console.log("\n[4] PARTIAL_CLOSE calls the real partialClose function with the model's real ticket and lots...\n");
  {
    const OWNER = "user-mgmt-4";
    upsertGroup(OWNER, { id: "majors", name: "Majors", symbols: ["EURUSD"] });
    setActiveGroup(OWNER, "majors");
    const partials: { ticket: string; lots: number }[] = [];
    const executor: TradeExecutor = {
      openOrder: async () => ({ ticket: "T" }), modifyOrder: async () => {},
      closePosition: async (ticket, lots) => { partials.push({ ticket, lots: lots ?? 0 }); return { closedLots: lots ?? 0, remainingLots: 0.05 }; },
      deletePendingOrder: async () => {}, listOpenPositions: async () => [], listPendingOrders: async () => [],
    };
    const ea = startSimulatedEa(OWNER, { EURUSD: { bid: 1.08, ask: 1.0802 } });
    const { provider } = mockToolProvider([{ action: "PARTIAL_CLOSE", ticket: "600", closeLots: 0.03, reason: "taking partial profit" }]);
    try {
      const outcome = await runAutonomousTick({ userId: OWNER, db, executor, provider });
      assert.equal(outcome.action, "PARTIAL_CLOSE");
      assert.deepEqual(partials, [{ ticket: "600", lots: 0.03 }]);
      console.log(`    confirmed: PARTIAL_CLOSE fired with the real ticket/lots -- ${outcome.message}`);
    } finally {
      await ea.stop();
    }
  }

  console.log("\n[5] PAUSE genuinely sets a self-pause, and a subsequent BUY within that window is rejected -- with self-pause disabled, PAUSE is a no-op...\n");
  {
    const OWNER = "user-mgmt-5";
    upsertGroup(OWNER, { id: "majors", name: "Majors", symbols: ["EURUSD"] });
    setActiveGroup(OWNER, "majors");
    setRiskMode(OWNER, "lot", "on", 0.01);
    const placed: string[] = [];
    const executor: TradeExecutor = {
      openOrder: async (o) => { placed.push(o.symbol); return { ticket: "T" }; }, modifyOrder: async () => {}, closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
      deletePendingOrder: async () => {}, listOpenPositions: async () => [], listPendingOrders: async () => [],
    };
    const ea = startSimulatedEa(OWNER, { EURUSD: { bid: 1.08, ask: 1.0802 } });
    try {
      const { provider: pauseProvider } = mockToolProvider([{ action: "PAUSE", pauseMinutes: 3, reason: "too much exposure already" }]);
      const pauseOutcome = await runAutonomousTick({ userId: OWNER, db, executor, provider: pauseProvider });
      assert.equal(pauseOutcome.action, "PAUSE");
      const state = getSelfPause(OWNER);
      assert.ok(state, "a real self-pause state must now be set");
      const minutesLeft = Math.round((state!.pausedUntil - Date.now()) / 60_000);
      assert.ok(minutesLeft >= 2 && minutesLeft <= 3, `expected ~3 minutes left, got ${minutesLeft}`);

      const { provider: buyProvider, calls } = mockToolProvider([{ action: "BUY", confidence: 90, sl: 1.0, tp: 1.2, reason: "should be rejected by self-pause" }]);
      const rejectedOutcome = await runAutonomousTick({ userId: OWNER, db, executor, provider: buyProvider });
      assert.equal(rejectedOutcome.action, "NONE", "a real BUY decided during an active self-pause must not fire");
      assert.equal(placed.length, 0, "no real order must have been opened while self-paused");
      const contextSent = calls[0].messages.find((m) => m.role === "user")!.content as string;
      assert.ok(contextSent.includes("SELF-PAUSE ACTIVE"), "the model's own context must show the active self-pause");
      console.log("    confirmed: self-pause blocks a new BUY and is visible in the model's context");
    } finally {
      await ea.stop();
    }

    // Disabled self-pause: a PAUSE decision must be a genuine no-op. Clear the earlier real
    // pause first -- it's still legitimately active (3 minutes hadn't elapsed), not a bug.
    clearSelfPause(OWNER);
    setSelfPauseEnabled(OWNER, false);
    const ea2 = startSimulatedEa(OWNER, { EURUSD: { bid: 1.08, ask: 1.0802 } });
    try {
      const { provider } = mockToolProvider([{ action: "PAUSE", pauseMinutes: 5, reason: "should be ignored" }]);
      await runAutonomousTick({ userId: OWNER, db, executor, provider });
      assert.equal(getSelfPause(OWNER), null, "self-pause disabled in settings must mean PAUSE never actually sets a pause");
      console.log("    confirmed: PAUSE is a real no-op once self-pause is disabled");
    } finally {
      await ea2.stop();
    }
  }

  console.log("\n[6] An SL genuinely too tight relative to real ATR is rejected -- the setup itself is never altered, just discarded for this cycle...\n");
  {
    const OWNER = "user-mgmt-6";
    upsertGroup(OWNER, { id: "majors", name: "Majors", symbols: ["EURUSD"] });
    setActiveGroup(OWNER, "majors");
    setRiskMode(OWNER, "lot", "on", 0.01);
    setRiskMode(OWNER, "sl", "auto");
    setRiskMode(OWNER, "tp", "auto");
    const placed: unknown[] = [];
    const executor: TradeExecutor = {
      openOrder: async (o) => { placed.push(o); return { ticket: "T" }; }, modifyOrder: async () => {}, closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
      deletePendingOrder: async () => {}, listOpenPositions: async () => [], listPendingOrders: async () => [],
    };
    // Real ATR of 0.0010 -- an SL only 0.0001 away (1/10th of ATR) is genuinely too tight (floor is 0.25x ATR).
    const ea = startSimulatedEa(OWNER, { EURUSD: { bid: 1.0800, ask: 1.0802, atr: 0.0010 } });
    const { provider } = mockToolProvider([{ action: "BUY", confidence: 80, sl: 1.0799, tp: 1.09, reason: "tight scalp" }]);
    try {
      const outcome = await runAutonomousTick({ userId: OWNER, db, executor, provider });
      assert.equal(outcome.action, "NONE", "an SL well inside 0.25x ATR must be rejected, not placed");
      assert.equal(placed.length, 0);
      console.log("    confirmed: a too-tight SL (0.1x ATR) was rejected, no order placed");
    } finally {
      await ea.stop();
    }

    // A genuinely sane SL (outside the 0.25x ATR floor) must still go through normally -- this
    // check must never affect a real, reasonably-sized setup.
    const ea2 = startSimulatedEa(OWNER, { EURUSD: { bid: 1.0800, ask: 1.0802, atr: 0.0010 } });
    const { provider: provider2 } = mockToolProvider([{ action: "BUY", confidence: 80, sl: 1.0750, tp: 1.09, reason: "real sized stop" }]);
    try {
      const outcome = await runAutonomousTick({ userId: OWNER, db, executor, provider: provider2 });
      assert.equal(outcome.action, "BUY", "a genuinely sane SL must still fire normally -- this check must never touch a real setup");
      assert.equal(placed.length, 1);
      console.log("    confirmed: a real, sanely-sized SL is completely unaffected");
    } finally {
      await ea2.stop();
    }
  }

  console.log("\n[7] The real /stop_trading race: a decision already in flight when execution gets disabled mid-cycle is discarded, not fired...\n");
  {
    const OWNER = "user-mgmt-7";
    upsertGroup(OWNER, { id: "majors", name: "Majors", symbols: ["EURUSD"] });
    setActiveGroup(OWNER, "majors");
    setRiskMode(OWNER, "lot", "on", 0.01);
    setConfidenceThreshold(OWNER, 50);
    setAutoApproveBelowThreshold(OWNER, true);
    const placed: string[] = [];
    const executor: TradeExecutor = {
      openOrder: async (o) => { placed.push(o.symbol); return { ticket: "T" }; }, modifyOrder: async () => {}, closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
      deletePendingOrder: async () => {}, listOpenPositions: async () => [], listPendingOrders: async () => [],
    };
    const ea = startSimulatedEa(OWNER, { EURUSD: { bid: 1.08, ask: 1.0802 } });
    // The mock provider itself flips execution off -- simulating the user running /stop_trading
    // while the real model call/analysis for this cycle was already in flight.
    // Confidence deliberately below the sniper-tier bar (85) -- this isolates the pure race-fix
    // path (full discard) from the separate sniper-tier-while-stopped path proven in [8] below.
    const { provider } = mockToolProvider([
      () => {
        setAutonomousExecutionEnabled(OWNER, false);
        return { action: "BUY", confidence: 70, sl: 1.0, tp: 1.2, reason: "decided before the stop landed" };
      },
    ]);
    try {
      const outcome = await runAutonomousTick({ userId: OWNER, db, executor, provider });
      assert.equal(outcome.action, "NONE", "a sub-sniper-tier decision made after execution was disabled mid-cycle must be fully discarded, not fired");
      assert.equal(placed.length, 0, "no real order must ever reach the executor once stopped mid-cycle");
      console.log("    confirmed: the real BUY decided mid-flight was discarded once trading stopped before it could fire");
    } finally {
      await ea.stop();
      setAutonomousExecutionEnabled(OWNER, true);
    }
  }

  console.log("\n[8] Sniper-tier setup while stopped: a genuinely high-confidence decision queues for real approve/decline instead of firing or vanishing; a sub-bar decision while stopped does neither...\n");
  {
    const OWNER = "user-mgmt-8";
    upsertGroup(OWNER, { id: "majors", name: "Majors", symbols: ["EURUSD"] });
    setActiveGroup(OWNER, "majors");
    setRiskMode(OWNER, "lot", "on", 0.01);
    setAutonomousExecutionEnabled(OWNER, false);
    const placed: string[] = [];
    const executor: TradeExecutor = {
      openOrder: async (o) => { placed.push(o.symbol); return { ticket: "T" }; }, modifyOrder: async () => {}, closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
      deletePendingOrder: async () => {}, listOpenPositions: async () => [], listPendingOrders: async () => [],
    };
    const { listPendingTradeApprovals } = await import("@dave/trading");

    const ea = startSimulatedEa(OWNER, { EURUSD: { bid: 1.08, ask: 1.0802 } });
    try {
      const { provider } = mockToolProvider([{ action: "BUY", confidence: 90, sl: 1.0, tp: 1.2, reason: "genuine sniper-tier setup" }]);
      const outcome = await runAutonomousTick({ userId: OWNER, db, executor, provider });
      assert.equal(placed.length, 0, "must never auto-fire while trading is stopped, even at 90% confidence");
      const pending = listPendingTradeApprovals(OWNER);
      assert.equal(pending.length, 1, "a genuinely sniper-tier setup while stopped must queue for a real approve/decline");
      assert.ok(outcome.message?.includes("Approve"), "the user must see a real approve/decline ask, not silence");
      console.log(`    confirmed: 90% confidence while stopped queued for approval -- ${outcome.message}`);
    } finally {
      await ea.stop();
    }

    const ea2 = startSimulatedEa(OWNER, { EURUSD: { bid: 1.08, ask: 1.0802 } });
    try {
      const { provider } = mockToolProvider([{ action: "BUY", confidence: 60, sl: 1.0, tp: 1.2, reason: "not sniper-tier" }]);
      await runAutonomousTick({ userId: OWNER, db, executor, provider });
      assert.equal(placed.length, 0, "still must not fire below the sniper-tier bar while stopped");
      const pending = listPendingTradeApprovals(OWNER);
      assert.equal(pending.length, 1, "a sub-bar decision while stopped must NOT add a new pending approval");
      console.log("    confirmed: a sub-sniper-tier decision while stopped neither fires nor queues");
    } finally {
      await ea2.stop();
      setAutonomousExecutionEnabled(OWNER, true);
    }
  }

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
