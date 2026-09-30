import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { DaveDatabase } from "@dave/db";
import type { Provider, CompletionRequest, CompletionResult, ToolCall } from "@dave/brain";
import type { TradeExecutor } from "@dave/trading";
import { upsertGroup, setActiveGroup, proposeProtectedLimitChange, approveProtectedLimitChange } from "@dave/trading";
import { getOrCreateEaWebhook, createEaWebhookServer, type EaCommand } from "@dave/ea-bridge";

/**
 * The trader (30 Sep, live): "the bot just marked a level and it didn't do anything -- same as the
 * self aware alert". Before: an alert was only a line in the next scan's prompt, that scan went to
 * the next pair in the rotation, a pair with an open trade was never scanned at all, and at max
 * open trades mode 2 stopped before picking any pair. Now an alert's pair is scanned next, with
 * the alert on top of the prompt, and a scan on an open trade manages it (never stacks an entry).
 */

console.log("=== Step 196: an alert makes mode 2 look at its pair and act ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-step196-"));
process.chdir(workDir);
process.env.DAVE_DATA_ROOT = workDir;
globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;

const { runAutonomousTick } = await import("../src/autonomous-tick.js");
const { focusScanOnAlert, resetAlertFocus } = await import("../src/alert-focus.js");
const { setAutonomousTradingEnabled } = await import("../src/autonomous-trading-state.js");
const { getCursorPosition } = await import("../src/autonomous-tick-state.js");
const { publishActivity } = await import("../src/activity-bus.js");

function startSimulatedEa(userId: string, priceBySymbol: Record<string, { bid: number; ask: number; atr?: number }>, positions: unknown[] = []) {
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
        const p = priceBySymbol[cmd.symbol] ?? { bid: 1, ask: 1.0002, atr: 0.001 };
        await postReport({ ...heartbeat, results: [{ commandId: cmd.id, status: "ok", data: { price: p, volatility: { atr: p.atr ?? 0.001 } } }] }).catch(() => undefined);
      }
      await new Promise((r) => setTimeout(r, 30));
    }
  })();
  return { stop: async () => { running = false; await loop; await ready; server.close(); } };
}

function mockToolProvider(decisions: Record<string, unknown>[]): { provider: Provider; calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  let i = 0;
  const provider: Provider = {
    name: "claude",
    generate: async (req: CompletionRequest): Promise<CompletionResult> => {
      calls.push(req);
      const args = decisions[Math.min(i, decisions.length - 1)];
      i++;
      const toolName = req.tools?.[0]?.name ?? "submit_trading_decision";
      const toolCalls: ToolCall[] = [{ id: `call-${i}`, name: toolName, arguments: args }];
      return { text: "", provider: "claude", latencyMs: 1, toolCalls };
    },
  };
  return { provider, calls };
}

/** Posts a heartbeat carrying a real open position so getLastKnownState reflects it before the
 *  tick runs -- same pattern step97 uses for DELETE_TICKET/PARTIAL_CLOSE. */
async function seedOpenPosition(userId: string, position: { ticket: string; symbol: string; type: string; lots: number; openPrice: number; sl?: number; tp?: number }) {
  const webhook = getOrCreateEaWebhook(userId);
  const server = createEaWebhookServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => {
    const body = JSON.stringify({ type: "heartbeat", account: "1", balance: 1000, positions: [position], pendingOrders: [] });
    const req = request({ hostname: "127.0.0.1", port, path: webhook.path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => { res.on("data", () => {}); res.on("end", () => resolve()); });
    req.on("error", reject); req.write(body); req.end();
  });
  server.close();
}


function executorSpy() {
  const opened: unknown[] = [];
  const modified: { ticket: string; changes: { sl?: number | null; tp?: number | null } }[] = [];
  const executor: TradeExecutor = {
    openOrder: async (o) => { opened.push(o); return { ticket: "NEW" }; },
    modifyOrder: async (ticket, changes) => { modified.push({ ticket, changes }); },
    closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
    deletePendingOrder: async () => {}, listOpenPositions: async () => [], listPendingOrders: async () => [],
  };
  return { executor, opened, modified };
}

const logs: string[] = [];
const origLog = console.log;
console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); origLog(...a); };

const lastPrompt = (calls: CompletionRequest[]) => calls.map((c) => c.messages.map((m) => String(m.content)).join("\n")).join("\n");

const GBP_TRADE = { ticket: "700", symbol: "GBPUSD", type: "buy", lots: 0.1, openPrice: 1.27, sl: 1.26, tp: 1.29 };

try {
  const db = new DaveDatabase(join(workDir, "dave.db"));

  console.log("[1] A trade alert at max open trades: that trade's pair is scanned and managed\n");
  {
    const OWNER = "alert-trade";
    upsertGroup(OWNER, { id: "majors", name: "Majors", symbols: ["EURUSD", "USDJPY"] });
    setActiveGroup(OWNER, "majors");
    const ch = proposeProtectedLimitChange(OWNER, "maxOpenTrades", 1, "test");
    approveProtectedLimitChange(OWNER, ch.id);
    setAutonomousTradingEnabled(OWNER, true);
    await seedOpenPosition(OWNER, GBP_TRADE);
    const ea = startSimulatedEa(OWNER, { GBPUSD: { bid: 1.2795, ask: 1.2797 } }, [GBP_TRADE]);
    resetAlertFocus();
    assert.equal(focusScanOnAlert(OWNER, "GBPUSD", "TRADE ALERT GBPUSD #700: in profit 5 min -- is the plan still valid?"), true);
    assert.equal(focusScanOnAlert(OWNER, "GBPUSD", "second alert straight after"), false, "one alert scan per pair per 2 min");
    const { executor, opened, modified } = executorSpy();
    const { provider, calls } = mockToolProvider([{ action: "MODIFY", ticket: "700", newSl: 1.2702, reason: "protect the profit -- stop to breakeven" }]);
    try {
      const before = getCursorPosition(OWNER).symbolCursor;
      const outcome = await runAutonomousTick({ userId: OWNER, db, executor, provider });
      const prompt = lastPrompt(calls);
      assert.match(prompt, /SYMBOL: GBPUSD/, "the alerted pair was analysed, even at max open trades");
      assert.match(prompt, /ALERT -- THIS SCAN WAS STARTED BY IT[\s\S]*in profit 5 min/);
      assert.match(prompt, /No new entry on GBPUSD/);
      assert.equal(outcome.action, "MODIFY");
      assert.equal(modified[0]?.ticket, "700");
      assert.equal(opened.length, 0);
      assert.equal(getCursorPosition(OWNER).symbolCursor, before, "the rotation keeps its place");
    } finally {
      await ea.stop();
    }
  }
  console.log("   ✓\n");

  console.log("[2] A scan started for an open trade never stacks a new entry on it\n");
  {
    const OWNER = "alert-trade";
    const ea = startSimulatedEa(OWNER, { GBPUSD: { bid: 1.2795, ask: 1.2797 } }, [GBP_TRADE]);
    resetAlertFocus();
    focusScanOnAlert(OWNER, "GBPUSD", "TRADE ALERT GBPUSD #700: near TP");
    const { executor, opened } = executorSpy();
    const { provider } = mockToolProvider([{ action: "BUY", sl: 1.275, tp: 1.29, confidence: 90, reason: "add to the winner" }]);
    try {
      const outcome = await runAutonomousTick({ userId: OWNER, db, executor, provider });
      assert.equal(opened.length, 0, "no second GBPUSD trade");
      assert.ok(logs.some((l) => /a new BUY on a pair with an open trade is not placed|no room for a new trade -- the BUY is not placed/.test(l)), "refused by the manage-only rule, not by chance");
      assert.notEqual(outcome.action, "BUY");
    } finally {
      await ea.stop();
    }
  }
  console.log("   ✓\n");

  console.log("[3] A marked level hit on a pair: that pair is scanned next, not the rotation's\n");
  {
    const OWNER = "alert-level";
    upsertGroup(OWNER, { id: "majors", name: "Majors", symbols: ["EURUSD", "USDJPY"] });
    setActiveGroup(OWNER, "majors");
    setAutonomousTradingEnabled(OWNER, true);
    const ea = startSimulatedEa(OWNER, { USDJPY: { bid: 150, ask: 150.02 }, EURUSD: { bid: 1.08, ask: 1.0802 } });
    resetAlertFocus();
    focusScanOnAlert(OWNER, "USDJPY", "LEVEL HIT: USDJPY reached 150.00 (marked: sell the retest)");
    const { executor } = executorSpy();
    const { provider, calls } = mockToolProvider([{ action: "SKIP", reason: "retest not confirmed yet" }]);
    try {
      await runAutonomousTick({ userId: OWNER, db, executor, provider });
      const prompt = lastPrompt(calls);
      assert.match(prompt, /SYMBOL: USDJPY/, "the level's pair, not EURUSD (first in the rotation)");
      assert.match(prompt, /LEVEL HIT: USDJPY reached 150\.00/);
      assert.match(prompt, /take the trade or arm the order now/);
      assert.match(prompt, /THIS PAIR RIGHT NOW: price [\s\S]*open trades on USDJPY: none; pending orders on USDJPY: none/);
      assert.equal(getCursorPosition(OWNER).symbolCursor, 0, "EURUSD is still next in the rotation");
    } finally {
      await ea.stop();
    }
  }
  console.log("   ✓\n");

  console.log("[4] A trade that closed before its alert scan: the alert is dropped, and never shown as live\n");
  {
    const OWNER = "alert-closed";
    upsertGroup(OWNER, { id: "majors", name: "Majors", symbols: ["EURUSD"] });
    setActiveGroup(OWNER, "majors");
    setAutonomousTradingEnabled(OWNER, true);
    const ea = startSimulatedEa(OWNER, { EURUSD: { bid: 1.08, ask: 1.0802 } });
    resetAlertFocus();
    focusScanOnAlert(OWNER, "GBPUSD", "TRADE ALERT GBPUSD #1237942718: up 1R -- move to breakeven");
    publishActivity(OWNER, "background", "self_aware", { text: "TRADE ALERT GBPUSD #1237942718: up 1R -- move to breakeven" });
    const { executor } = executorSpy();
    const { provider, calls } = mockToolProvider([{ action: "SKIP", reason: "nothing" }]);
    try {
      await runAutonomousTick({ userId: OWNER, db, executor, provider });
      const prompt = lastPrompt(calls);
      assert.match(prompt, /SYMBOL: EURUSD/, "the closed trade's pair is not scanned for it");
      assert.ok(!/SELF-AWARE ALERTS[\s\S]*up 1R -- move to breakeven/.test(prompt), "the closed trade's alert is not in the feed");
      assert.ok(!prompt.includes("1237942718"), "a EURUSD scan carries nothing about the closed GBPUSD trade (one thing per scan)");
      assert.ok(logs.some((l) => /alert focus on GBPUSD dropped -- trade #1237942718 is already closed/.test(l)));
    } finally {
      await ea.stop();
    }
  }
  console.log("   ✓\n");

  console.log("[5] A rotation scan carries only its own pair -- other pairs' alerts and calls stay out\n");
  {
    const OWNER = "alert-alone";
    upsertGroup(OWNER, { id: "majors", name: "Majors", symbols: ["EURUSD", "USDJPY"] });
    setActiveGroup(OWNER, "majors");
    const ea = startSimulatedEa(OWNER, { EURUSD: { bid: 1.08, ask: 1.0802 } });
    publishActivity(OWNER, "background", "level_hit", { text: "LEVEL HIT: USDJPY reached 150.00 (marked: sell the retest)" });
    publishActivity(OWNER, "background", "level_hit", { text: "LEVEL HIT: EURUSD reached 1.0800 (marked: buy the sweep)" });
    const { executor } = executorSpy();
    const { provider, calls } = mockToolProvider([{ action: "SKIP", reason: "nothing" }]);
    try {
      await runAutonomousTick({ userId: OWNER, db, executor, provider });
      const prompt = lastPrompt(calls);
      assert.match(prompt, /SYMBOL: EURUSD/);
      assert.match(prompt, /EURUSD reached 1\.0800/, "this pair's own alert is there");
      assert.ok(!prompt.includes("USDJPY reached"), "another pair's alert is not");
    } finally {
      await ea.stop();
    }
  }
  console.log("   ✓\n");

  console.log("[6] Mode 2 off: an alert queues nothing\n");
  setAutonomousTradingEnabled("alert-off", false);
  assert.equal(focusScanOnAlert("alert-off", "EURUSD", "x"), false);
  console.log("   ✓\n");

  db.close();
  console.log("=== Step 196 passed ===");
} finally {
  process.chdir(tmpdir());
  rmSync(workDir, { recursive: true, force: true });
}
process.exit(0);
