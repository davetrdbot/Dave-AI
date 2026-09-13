import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { DaveDatabase } from "@dave/db";
import type { Provider, CompletionRequest, CompletionResult, ToolCall } from "@dave/brain";
import type { TradeExecutor } from "@dave/trading";
import { upsertGroup, setActiveGroup, setRiskMode } from "@dave/trading";
import { getOrCreateEaWebhook, createEaWebhookServer, type EaCommand } from "@dave/ea-bridge";
import { runAutonomousTick } from "../src/autonomous-tick.js";
import { getCursorPosition, setPendingSymbolOverride, consumePendingSymbolOverride } from "../src/autonomous-tick-state.js";

/**
 * Real proof for two extensions to the autonomous tick this session:
 *
 * (a)/(b) requestedNextSymbol/requestedNextReason on ANY decision genuinely persists a pending
 *     symbol override, honored on the VERY NEXT cycle instead of the mechanical round-robin
 *     symbol, and consumed exactly once -- a third cycle returns to normal round-robin, never
 *     stuck repeating the override.
 * (c) A requested symbol that's no longer genuinely valid (already carries an open position) is
 *     skipped, with a real logged reason, falling back to normal round-robin for that cycle --
 *     never silently ignored, never a crash.
 * (d) REQUEST_CANDLES now genuinely works on an ordinary cycle with no active SL-danger alert --
 *     fetches for the symbol actually being analyzed, exactly once, re-invokes the decision tool
 *     exactly once more -- and a REPEAT REQUEST_CANDLES on that second call falls back to SKIP
 *     rather than looping, mirroring CONSULT_JOURNAL's own real repeat-guard.
 */

console.log("=== Real proof: requested-next-symbol override + general REQUEST_CANDLES ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-next-symbol-"));
process.chdir(workDir);

const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;

/** Simulated EA answering every "analyze" command, counting endpoint hits per symbol so
 *  REQUEST_CANDLES's "exactly once" bound and the override's real symbol substitution are both
 *  checkable, not asserted by hand. */
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
        const key = `${cmd.symbol}:${cmd.endpoint}`;
        endpointCalls[key] = (endpointCalls[key] ?? 0) + 1;
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

async function seedOpenPosition(userId: string, position: { ticket: string; symbol: string; type: string; lots: number; openPrice: number }) {
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

function symbolFromContext(content: string): string | undefined {
  return content.split("\n").find((l) => l.startsWith("SYMBOL: "))?.slice("SYMBOL: ".length);
}

try {
  const db = new DaveDatabase(join(workDir, "dave.db"));

  console.log("[unit] setPendingSymbolOverride/consumePendingSymbolOverride: persists, and consumption clears it -- a second read after consuming returns null...\n");
  {
    const U = "user-override-unit";
    assert.equal(consumePendingSymbolOverride(U), null, "nothing pending yet");
    setPendingSymbolOverride(U, "EURUSD", "test reason");
    const first = consumePendingSymbolOverride(U);
    assert.ok(first && first.symbol === "EURUSD" && first.reason === "test reason", "the real override must be persisted and readable");
    const second = consumePendingSymbolOverride(U);
    assert.equal(second, null, "consuming the override must genuinely clear it -- it must not be readable a second time");
    console.log("    confirmed: real persist + exactly-once consumption at the state layer");
  }

  console.log("\n[a+b] A decision's requestedNextSymbol genuinely persists an override, is honored on the VERY NEXT cycle instead of the mechanical round-robin symbol, and is consumed exactly once -- a THIRD cycle returns to normal round-robin...\n");
  {
    const OWNER = "user-override-ab";
    upsertGroup(OWNER, { id: "majors", name: "Majors", symbols: ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD"] });
    setActiveGroup(OWNER, "majors");
    const executor: TradeExecutor = {
      openOrder: async () => ({ ticket: "T" }), modifyOrder: async () => {}, closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
      deletePendingOrder: async () => {}, listOpenPositions: async () => [], listPendingOrders: async () => [],
    };
    const endpointCalls: Record<string, number> = {};
    const ea = startSimulatedEa(OWNER, endpointCalls);
    const { provider, calls } = mockToolProvider([
      { action: "SKIP", reason: "nothing on EURUSD right now", requestedNextSymbol: "AUDUSD", requestedNextReason: "want to re-check this once related news settles" },
      { action: "SKIP", reason: "AUDUSD checked per the earlier request, still nothing" },
      { action: "SKIP", reason: "back to normal scanning" },
    ]);
    try {
      const outcome1 = await runAutonomousTick({ userId: OWNER, db, executor, provider });
      const symbol1 = symbolFromContext(calls[0].messages.find((m) => m.role === "user")!.content as string);
      console.log(`    tick 1: analyzed ${symbol1} (mechanical), outcome=${outcome1.action}, requested AUDUSD for next cycle`);
      assert.equal(symbol1, "EURUSD", "tick 1 must be the mechanical round-robin symbol (cursor 0)");

      const outcome2 = await runAutonomousTick({ userId: OWNER, db, executor, provider });
      const symbol2 = symbolFromContext(calls[1].messages.find((m) => m.role === "user")!.content as string);
      console.log(`    tick 2: analyzed ${symbol2} (should be the REQUESTED AUDUSD, not the mechanical next-in-sequence GBPUSD)`);
      assert.equal(symbol2, "AUDUSD", "tick 2 must honor the requested override symbol, not the mechanical round-robin next");
      void outcome2;

      const outcome3 = await runAutonomousTick({ userId: OWNER, db, executor, provider });
      const symbol3 = symbolFromContext(calls[2].messages.find((m) => m.role === "user")!.content as string);
      console.log(`    tick 3: analyzed ${symbol3} (must be normal round-robin again, NOT stuck repeating AUDUSD)`);
      assert.notEqual(symbol3, "AUDUSD", "the override must be consumed exactly once -- a third cycle must not repeat it");
      assert.equal(symbol3, "USDJPY", "tick 3 must be the real mechanical round-robin symbol the cursor had independently advanced to");

      // Direct proof the override is genuinely gone at the state layer too, not just inferred from outcomes.
      assert.equal(consumePendingSymbolOverride(OWNER), null, "no pending override should remain after it was honored once");
      console.log("    confirmed: override honored exactly once, then genuinely cleared");
    } finally {
      await ea.stop();
    }
  }

  console.log("\n[c] A requested symbol that's no longer valid (already has an open position) is skipped with a real logged reason, falling back to normal round-robin for that cycle -- no crash, not silently ignored...\n");
  {
    const OWNER = "user-override-invalid";
    upsertGroup(OWNER, { id: "majors", name: "Majors", symbols: ["EURUSD", "GBPUSD"] });
    setActiveGroup(OWNER, "majors");
    const executor: TradeExecutor = {
      openOrder: async () => ({ ticket: "T" }), modifyOrder: async () => {}, closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
      deletePendingOrder: async () => {}, listOpenPositions: async () => [], listPendingOrders: async () => [],
    };
    const endpointCalls: Record<string, number> = {};
    const ea = startSimulatedEa(OWNER, endpointCalls);
    const { provider, calls } = mockToolProvider([
      { action: "SKIP", reason: "nothing on EURUSD", requestedNextSymbol: "GBPUSD", requestedNextReason: "want a look at GBPUSD next" },
      { action: "SKIP", reason: "fallback tick" },
    ]);
    const logs: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(" ")); realLog(...args); };
    try {
      await runAutonomousTick({ userId: OWNER, db, executor, provider });
      // GBPUSD now genuinely carries an open position before the requested cycle runs -- the exact
      // real invalidity example the spec calls out.
      await seedOpenPosition(OWNER, { ticket: "T-GBP", symbol: "GBPUSD", type: "buy", lots: 0.1, openPrice: 1.27 });
      const outcome2 = await runAutonomousTick({ userId: OWNER, db, executor, provider });
      const symbol2 = symbolFromContext(calls[1].messages.find((m) => m.role === "user")!.content as string);
      console.log(`    tick 2: requested GBPUSD is now invalid (open position) -- real fallback symbol analyzed: ${symbol2}`);
      assert.notEqual(symbol2, "GBPUSD", "an invalid requested symbol must NEVER be analyzed -- the same real validity checks apply to an override as to normal round-robin");
      assert.equal(symbol2, "EURUSD", "must genuinely fall back to normal round-robin for this cycle");
      assert.equal(outcome2.action, "NONE");
      assert.ok(
        logs.some((l) => l.includes("requested-next-symbol override skipped") && l.includes("GBPUSD") && l.includes("already has an open position")),
        "a real, specific reason for skipping the override must be logged -- not silently ignored"
      );
      console.log("    confirmed: invalid override real-logged and skipped, real round-robin fallback used, no crash");
    } finally {
      console.log = realLog;
      await ea.stop();
    }
  }

  console.log("\n[d] REQUEST_CANDLES now genuinely works on an ORDINARY cycle (no active SL-danger alert) -- fetches for the symbol actually being analyzed exactly once, re-invokes the decision tool exactly once more, and a REPEAT REQUEST_CANDLES on the second call falls back to SKIP rather than looping...\n");
  {
    const OWNER = "user-general-candles";
    upsertGroup(OWNER, { id: "majors", name: "Majors", symbols: ["EURUSD"] });
    setActiveGroup(OWNER, "majors");
    const executor: TradeExecutor = {
      openOrder: async () => ({ ticket: "T" }), modifyOrder: async () => {}, closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
      deletePendingOrder: async () => {}, listOpenPositions: async () => [], listPendingOrders: async () => [],
    };
    const endpointCalls: Record<string, number> = {};
    const ea = startSimulatedEa(OWNER, endpointCalls);
    let decisionCalls = 0;
    const provider: Provider = {
      name: "mock",
      generate: async (req: CompletionRequest): Promise<CompletionResult> => {
        decisionCalls++;
        // Always asks for candles again, to prove the repeat-guard, not just the happy path.
        const args = { action: "REQUEST_CANDLES", reason: `wants a fresh look, call ${decisionCalls}` };
        const toolCalls: ToolCall[] = [{ id: `call-${decisionCalls}`, name: "submit_trading_decision", arguments: args }];
        return { text: "", provider: "mock", latencyMs: 1, toolCalls };
      },
    };
    try {
      const outcome = await runAutonomousTick({ userId: OWNER, db, executor, provider });
      console.log(`    real outcome: ${JSON.stringify(outcome)}, decision calls=${decisionCalls}, candles endpoint hits=${endpointCalls["EURUSD:candles"] ?? 0}`);
      assert.equal(decisionCalls, 2, "the decision tool must be invoked exactly twice: once for the REQUEST_CANDLES ask, once more for the real re-decision");
      assert.equal(endpointCalls["EURUSD:candles"], 1, "the real candles endpoint must be called exactly once for the symbol actually being analyzed -- never a loop");
      assert.equal(outcome.action, "NONE", "a REPEAT REQUEST_CANDLES on the second call must be rejected/fall back to SKIP, not fire a second fetch");
    } finally {
      await ea.stop();
    }

    console.log("\n    ...and the happy path: REQUEST_CANDLES on an ordinary cycle, then a real final decision after the candles come back...\n");
    const OWNER2 = "user-general-candles-2";
    upsertGroup(OWNER2, { id: "majors", name: "Majors", symbols: ["EURUSD"] });
    setActiveGroup(OWNER2, "majors");
    setRiskMode(OWNER2, "sl", "off");
    setRiskMode(OWNER2, "tp", "off");
    setRiskMode(OWNER2, "lot", "on", 0.02);
    const executor2: TradeExecutor = {
      openOrder: async () => ({ ticket: "T2" }), modifyOrder: async () => {}, closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
      deletePendingOrder: async () => {}, listOpenPositions: async () => [], listPendingOrders: async () => [],
    };
    const endpointCalls2: Record<string, number> = {};
    const ea2 = startSimulatedEa(OWNER2, endpointCalls2);
    let decisionCalls2 = 0;
    const provider2: Provider = {
      name: "mock",
      generate: async (req: CompletionRequest): Promise<CompletionResult> => {
        decisionCalls2++;
        const args =
          decisionCalls2 === 1
            ? { action: "REQUEST_CANDLES", reason: "want fresh price action before an ordinary decision" }
            : { action: "SKIP", reason: "fresh candles reviewed, still nothing real here" };
        const toolCalls: ToolCall[] = [{ id: `c2-${decisionCalls2}`, name: "submit_trading_decision", arguments: args }];
        return { text: "", provider: "mock", latencyMs: 1, toolCalls };
      },
    };
    try {
      const outcome2 = await runAutonomousTick({ userId: OWNER2, db, executor: executor2, provider: provider2 });
      console.log(`    real outcome: ${JSON.stringify(outcome2)}, decision calls=${decisionCalls2}, candles endpoint hits=${endpointCalls2["EURUSD:candles"] ?? 0}`);
      assert.equal(decisionCalls2, 2, "exactly two decision calls for the real REQUEST_CANDLES -> re-decide round trip");
      assert.equal(endpointCalls2["EURUSD:candles"], 1, "real candles endpoint hit exactly once");
      assert.equal(outcome2.action, "NONE", "the real final SKIP decision after reviewing candles must be honored");
      console.log("    confirmed: REQUEST_CANDLES works generally on an ordinary cycle, bounded to exactly one extra round trip");
    } finally {
      await ea2.stop();
    }
  }

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
