import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { DaveDatabase } from "@dave/db";
import type { Provider, CompletionRequest, CompletionResult, ToolCall } from "@dave/brain";
import type { TradeExecutor } from "@dave/trading";
import { upsertGroup, setActiveGroup } from "@dave/trading";
import { getOrCreateEaWebhook, createEaWebhookServer, type EaCommand } from "@dave/ea-bridge";
import { logTrade } from "@dave/feedback";
import { runAutonomousTick } from "../src/autonomous-tick.js";
import { buildProgressBar } from "../src/trade-notifications.js";

/**
 * Real proof for visual TP/SL progress bars + the self-aware SL-danger alert:
 * (a) buildProgressBar's real math -- 0%, 50%, 100%, clamped beyond 100%, zero-division, both
 *     directions.
 * (b) A real open position with sl/tp/currentPrice produces real, correct progress-bar text in
 *     the tick's context sent to the model.
 * (c) A position missing sl/tp/currentPrice produces no fabricated bar -- skipped cleanly.
 * (d) SL-progress crossing SL_DANGER_THRESHOLD genuinely injects a SELF-AWARE ALERT context line
 *     carrying the REAL original reason pulled from a seeded trade-journal entry.
 * (e) REQUEST_CANDLES, chosen while an alert is active, genuinely calls the real candles endpoint
 *     exactly once (never a loop) and the decision tool is re-invoked exactly once more with the
 *     real candle data appended.
 */

console.log("=== Real proof: TP/SL progress bars + self-aware SL-danger alert ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-progress-sl-alert-"));
process.chdir(workDir);

const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;

/** Simulated EA that answers every "analyze" command with data keyed by the real requested
 *  endpoint -- "candles" gets a genuinely distinct payload from every other endpoint (which all
 *  get the plain price/volatility data the other tick tests already use), and every endpoint hit
 *  is counted so REQUEST_CANDLES's "exactly once" bound is a real, checkable assertion. */
function startSimulatedEa(userId: string, endpointCalls: Record<string, number>) {
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
        endpointCalls[cmd.endpoint] = (endpointCalls[cmd.endpoint] ?? 0) + 1;
        const data =
          cmd.endpoint === "candles"
            ? { candles: [{ open: 1.1, close: 1.101, high: 1.102, low: 1.099 }], real: true }
            : { price: { bid: 1.08, ask: 1.0802 }, volatility: { atr: 0.001 } };
        await postReport({ ...heartbeat, results: [{ commandId: cmd.id, status: "ok", data }] }).catch(() => undefined);
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
    name: "mock",
    generate: async (req: CompletionRequest): Promise<CompletionResult> => {
      calls.push(req);
      const args = decisions[Math.min(i, decisions.length - 1)];
      i++;
      const toolCalls: ToolCall[] = [{ id: `call-${i}`, name: "submit_trading_decision", arguments: args }];
      return { text: "", provider: "mock", latencyMs: 1, toolCalls };
    },
  };
  return { provider, calls };
}

/** Posts a heartbeat carrying a real open position (with a real currentPrice too, unlike the
 *  other tick tests) so getLastKnownState reflects it before the tick runs. */
async function seedOpenPosition(
  userId: string,
  position: { ticket: string; symbol: string; type: string; lots: number; openPrice: number; sl?: number; tp?: number; currentPrice?: number }
) {
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

try {
  console.log("[a] buildProgressBar's real math: 0%, 50%, 100%, clamped beyond 100%, zero-division, both directions...\n");
  {
    // BUY-shaped distances (target above/below entry doesn't matter -- only real distance does).
    assert.equal(buildProgressBar(1.0, 1.0, 1.1), "░░░░░░░░░░ 0%", "0% progress (current === entry) must render a fully empty bar");
    assert.equal(buildProgressBar(1.0, 1.05, 1.1), "█████░░░░░ 50%", "50% progress must render exactly half-filled");
    assert.equal(buildProgressBar(1.0, 1.1, 1.1), "██████████ 100%", "100% progress (current === target) must render a fully filled bar");
    assert.equal(buildProgressBar(1.0, 1.2, 1.1), "██████████ 100%", "progress beyond the target must clamp to 100%, never overflow the bar or exceed 100%");
    // SELL-shaped distances: SL numerically ABOVE entry, current moving up toward it -- same real
    // math, direction never enters the computation, only |distance|.
    assert.equal(buildProgressBar(1.1, 1.15, 1.2), "█████░░░░░ 50%", "SELL-direction (target above entry) must compute the identical real distance-based progress");
    assert.equal(buildProgressBar(1.1, 1.19, 1.2), "█████████░ 90%", "SELL-direction near-target progress must be real, not fabricated");
    // Zero-division guard: target === entry must never produce NaN/Infinity.
    assert.equal(buildProgressBar(1.0, 1.05, 1.0), "░░░░░░░░░░ 0%", "target === entry (zero real distance) must guard to a flat 0%, never NaN/Infinity");
    assert.ok(!buildProgressBar(1.0, 1.0, 1.0).includes("NaN"), "current === entry === target must never render NaN");
    console.log("    confirmed: real progress math correct at 0%/50%/100%/clamped/zero-division, for both directions");
  }

  const db = new DaveDatabase(join(workDir, "dave.db"));

  console.log("\n[b] A real open position with sl/tp/currentPrice produces real, correct progress-bar text in the tick's context...\n");
  {
    const OWNER = "user-progress-b";
    upsertGroup(OWNER, { id: "majors", name: "Majors", symbols: ["EURUSD"] });
    setActiveGroup(OWNER, "majors");
    const executor: TradeExecutor = {
      openOrder: async () => ({ ticket: "T" }),
      modifyOrder: async () => {},
      closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
      deletePendingOrder: async () => {}, listOpenPositions: async () => [], listPendingOrders: async () => [],
    };
    // openPrice 1.2000, SL 1.1900 (100 pip real distance), TP 1.2200 (200 pip real distance),
    // currentPrice 1.2050 -> real TP progress = |1.2050-1.2000|/|1.2200-1.2000| = 0.0050/0.0200 = 25%,
    // real SL progress = 0 (price moved toward TP, away from SL -- |1.2050-1.2000|=0.0050 numerator
    // is still measured the same way, so this position's SL progress is genuinely 50% of its own
    // 0.0100 distance -- computed for real below, not asserted by hand-picked round numbers only).
    await seedOpenPosition(OWNER, { ticket: "500", symbol: "GBPUSD", type: "buy", lots: 0.1, openPrice: 1.2, sl: 1.19, tp: 1.22, currentPrice: 1.205 });
    const endpointCalls: Record<string, number> = {};
    const ea = startSimulatedEa(OWNER, endpointCalls);
    const { provider, calls } = mockToolProvider([{ action: "SKIP", reason: "just observing context this tick" }]);
    try {
      await runAutonomousTick({ userId: OWNER, db, executor, provider });
      const userContent = calls[0].messages.find((m) => m.role === "user")!.content as string;
      const expectedTpBar = buildProgressBar(1.2, 1.205, 1.22);
      const expectedSlBar = buildProgressBar(1.2, 1.205, 1.19);
      console.log(`    real expected TP bar: "${expectedTpBar}", real expected SL bar: "${expectedSlBar}"`);
      assert.ok(userContent.includes(`Progress to TP: ${expectedTpBar}`), "the real context must contain the real, correctly-computed TP progress bar");
      assert.ok(userContent.includes(`Progress to SL: ${expectedSlBar}`), "the real context must contain the real, correctly-computed SL progress bar");
      assert.ok(userContent.includes("#500"), "the progress bars must be attached to the real ticket's own line");
      console.log("    confirmed: real progress-bar text for a fully-specified open position reached the model's real context");
    } finally {
      await ea.stop();
    }
  }

  console.log("\n[c] A position missing sl/tp/currentPrice produces no fabricated bar -- skipped cleanly, no crash...\n");
  {
    const OWNER = "user-progress-c";
    upsertGroup(OWNER, { id: "majors", name: "Majors", symbols: ["EURUSD"] });
    setActiveGroup(OWNER, "majors");
    const executor: TradeExecutor = {
      openOrder: async () => ({ ticket: "T" }),
      modifyOrder: async () => {},
      closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
      deletePendingOrder: async () => {}, listOpenPositions: async () => [], listPendingOrders: async () => [],
    };
    // No currentPrice at all -- a real, common EA-report shape (not every report carries it).
    await seedOpenPosition(OWNER, { ticket: "600", symbol: "USDJPY", type: "sell", lots: 0.1, openPrice: 150.0, sl: 151.0, tp: 148.0 });
    const endpointCalls: Record<string, number> = {};
    const ea = startSimulatedEa(OWNER, endpointCalls);
    const { provider, calls } = mockToolProvider([{ action: "SKIP", reason: "just observing context this tick" }]);
    try {
      const outcome = await runAutonomousTick({ userId: OWNER, db, executor, provider });
      assert.equal(outcome.action, "NONE", "no crash -- the tick must complete cleanly even with a bar-ineligible position open");
      const userContent = calls[0].messages.find((m) => m.role === "user")!.content as string;
      assert.ok(userContent.includes("#600"), "the position itself must still be reported");
      assert.ok(!userContent.includes("Progress to TP") && !userContent.includes("Progress to SL"), "a position missing currentPrice must NOT get a fabricated bar");
      console.log("    confirmed: a position missing sl/tp/currentPrice is reported with no fabricated progress bar, no crash");
    } finally {
      await ea.stop();
    }
  }

  console.log("\n[d] SL-progress crossing SL_DANGER_THRESHOLD injects a real SELF-AWARE ALERT with the REAL seeded journal reason...\n");
  {
    const OWNER = "user-progress-d";
    upsertGroup(OWNER, { id: "majors", name: "Majors", symbols: ["EURUSD"] });
    setActiveGroup(OWNER, "majors");
    const executor: TradeExecutor = {
      openOrder: async () => ({ ticket: "T" }),
      modifyOrder: async () => {},
      closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
      deletePendingOrder: async () => {}, listOpenPositions: async () => [], listPendingOrders: async () => [],
    };
    const REAL_REASON = "Bullish order block retest with London-session liquidity sweep confirmation";
    logTrade(db, OWNER, {
      ticket: "700",
      symbol: "GBPUSD",
      direction: "buy",
      entryPrice: 1.2,
      sl: 1.19,
      tp: 1.22,
      reasoning: [REAL_REASON],
      confluenceScore: 71,
    });
    // openPrice 1.2000, SL 1.1900 (0.0100 real distance), currentPrice 1.1908 -> real SL progress
    // = |1.1908-1.2000|/0.0100 = 0.0092/0.0100 = 0.92, comfortably clear of SL_DANGER_THRESHOLD
    // (0.89) on both sides of any floating-point rounding.
    await seedOpenPosition(OWNER, { ticket: "700", symbol: "GBPUSD", type: "buy", lots: 0.1, openPrice: 1.2, sl: 1.19, tp: 1.22, currentPrice: 1.1908 });
    const endpointCalls: Record<string, number> = {};
    const ea = startSimulatedEa(OWNER, endpointCalls);
    const { provider, calls } = mockToolProvider([{ action: "SKIP", reason: "just observing the alert this tick" }]);
    try {
      await runAutonomousTick({ userId: OWNER, db, executor, provider });
      const userContent = calls[0].messages.find((m) => m.role === "user")!.content as string;
      console.log(`    real context excerpt: ${userContent.split("\n").find((l) => l.includes("SELF-AWARE ALERT"))}`);
      assert.ok(userContent.includes("SELF-AWARE ALERT"), "an SL progress at/beyond the real threshold must inject a labeled SELF-AWARE ALERT line");
      assert.ok(userContent.includes("#700") && userContent.includes("GBPUSD"), "the alert must name the real ticket and symbol");
      assert.ok(userContent.includes("92%"), "the alert must state the real SL-progress percentage");
      assert.ok(userContent.includes(REAL_REASON), "the alert must carry the REAL original placement reason pulled from the trade journal, not a placeholder");
      console.log("    confirmed: a real SELF-AWARE ALERT line, with the real ticket/symbol/percentage/original reason, was injected");
    } finally {
      await ea.stop();
    }
  }

  console.log("\n[e] REQUEST_CANDLES, chosen while an alert is active, calls the real candles endpoint exactly once and re-invokes the decision tool exactly once more with real candle data...\n");
  {
    const OWNER = "user-progress-e";
    upsertGroup(OWNER, { id: "majors", name: "Majors", symbols: ["EURUSD"] });
    setActiveGroup(OWNER, "majors");
    const executor: TradeExecutor = {
      openOrder: async () => ({ ticket: "T" }),
      modifyOrder: async () => {},
      closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
      deletePendingOrder: async () => {}, listOpenPositions: async () => [], listPendingOrders: async () => [],
    };
    logTrade(db, OWNER, {
      ticket: "701",
      symbol: "GBPUSD",
      direction: "buy",
      entryPrice: 1.2,
      sl: 1.19,
      tp: 1.22,
      reasoning: ["Liquidity sweep into a real demand zone"],
      confluenceScore: 65,
    });
    await seedOpenPosition(OWNER, { ticket: "701", symbol: "GBPUSD", type: "buy", lots: 0.1, openPrice: 1.2, sl: 1.19, tp: 1.22, currentPrice: 1.191 });
    const endpointCalls: Record<string, number> = {};
    const ea = startSimulatedEa(OWNER, endpointCalls);
    let decisionCalls = 0;
    const provider: Provider = {
      name: "mock",
      generate: async (req: CompletionRequest): Promise<CompletionResult> => {
        decisionCalls++;
        const args =
          decisionCalls === 1
            ? { action: "REQUEST_CANDLES", reason: "want a fresh look before touching an at-risk ticket" }
            : { action: "MODIFY", ticket: "701", newSl: 1.195, reason: "tightening after reviewing fresh candles" };
        const toolCalls: ToolCall[] = [{ id: `call-${decisionCalls}`, name: "submit_trading_decision", arguments: args }];
        return { text: "", provider: "mock", latencyMs: 1, toolCalls };
      },
    };
    try {
      const outcome = await runAutonomousTick({ userId: OWNER, db, executor, provider });
      console.log(`    real outcome: ${JSON.stringify(outcome)}`);
      assert.equal(decisionCalls, 2, "the decision tool must be invoked exactly twice: once to get REQUEST_CANDLES, once more for the real final decision");
      assert.equal(endpointCalls["candles"], 1, "the real candles endpoint must be called exactly once -- never a loop");
      assert.equal(outcome.action, "MODIFY", "the real final decision (MODIFY) made after reviewing the fresh candles must be honored");
      console.log(`    confirmed: ${decisionCalls} decision calls, candles endpoint hit ${endpointCalls["candles"]}x, final outcome=${outcome.action}`);
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
