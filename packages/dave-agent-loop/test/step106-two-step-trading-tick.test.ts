import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { DaveDatabase } from "@dave/db";
import type { Provider, CompletionRequest, CompletionResult, ToolCall } from "@dave/brain";
import type { TradeExecutor, OrderRequest } from "@dave/trading";
import { upsertGroup, setActiveGroup, getTwoStepTradingEnabled, setTwoStepTradingEnabled } from "@dave/trading";
import { getOrCreateEaWebhook, createEaWebhookServer, type EaCommand } from "@dave/ea-bridge";
import { runAutonomousTick } from "../src/autonomous-tick.js";

/**
 * Real proof for "Two-step trading" wired into the autonomous tick, and the general
 * limit/stop-order -> market conversion that lives alongside it (autonomous-tick.ts):
 *
 * (b) A real Flo decline is honored as a genuine SKIP -- no trade fires, the user sees Flo's real reason.
 * (c) A real Flo approval proceeds through the unmodified final-gate/execute path, with Flo's real
 *     reason surfaced in the trade-placed message.
 * (g) The settings toggle defaults OFF, and with it off Flo is never consulted at all -- the
 *     existing single-step trade path is completely unaffected by default (regression).
 * (f) A pending order (BUY_LIMIT/SELL_LIMIT/BUY_STOP/SELL_STOP) whose entry the real live price has
 *     already reached/passed is rewritten in code to the equivalent real MARKET action, sl/tp kept
 *     exactly as decided -- and, as a regression, a pending order whose entry price has NOT yet
 *     been reached is placed exactly as decided, unconverted.
 */

console.log("=== Real proof: two-step trading wired into the tick, and the limit/stop->market conversion ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-two-step-tick-"));
process.chdir(workDir);

const realFetch = globalThis.fetch;
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

/** Distinguishes the tick's own decision call (exactly one tool: submit_trading_decision) from a
 *  Flo consult call (many analysis tools + flo_decision), the same way real Dave/Flo requests are
 *  actually shaped -- see EA_ANALYSIS_TOOLS/flo-agent.ts. */
function makeProvider(opts: { tickDecision: Record<string, unknown>; floVerdict?: { approve: boolean; reason: string } }) {
  let tickCalls = 0;
  let floCalls = 0;
  let floAnswered = false;
  const provider: Provider = {
    name: "mock",
    generate: async (req: CompletionRequest): Promise<CompletionResult> => {
      const isTickDecision = req.tools?.length === 1 && req.tools[0].name === "submit_trading_decision";
      if (isTickDecision) {
        tickCalls++;
        const toolCalls: ToolCall[] = [{ id: `t${tickCalls}`, name: "submit_trading_decision", arguments: opts.tickDecision }];
        return { text: "", provider: "mock", latencyMs: 1, toolCalls };
      }
      const isFlo = req.tools?.some((t) => t.name === "flo_decision");
      if (isFlo) {
        assert.ok(!req.tools?.some((t) => t.name === "get_all_analysis" || t.name === "trade_execute"), "Flo must never be given get_all_analysis or a trading tool");
        // A real model calls flo_decision exactly once to CONCLUDE its review -- once answered,
        // any further turn (the loop continuing after the tool result) just returns plain text,
        // exactly like a real model that's already given its verdict would.
        if (floAnswered) {
          return { text: "Already answered.", provider: "mock", latencyMs: 1 };
        }
        floAnswered = true;
        floCalls++;
        const verdict = opts.floVerdict ?? { approve: true, reason: "looks fine" };
        const toolCalls: ToolCall[] = [{ id: `f${floCalls}`, name: "flo_decision", arguments: verdict }];
        return { text: "", provider: "mock", latencyMs: 1, toolCalls };
      }
      throw new Error(`unexpected provider call with tools: ${req.tools?.map((t) => t.name).join(",")}`);
    },
  };
  return { provider, calls: () => ({ tickCalls, floCalls }) };
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

async function main() {
  const db = new DaveDatabase(join(workDir, "dave.db"));

  console.log("[1] Default: two-step trading is OFF, and Flo is genuinely never consulted -- the existing single-step path is unaffected...\n");
  {
    const OWNER = "user-two-step-default-off";
    upsertGroup(OWNER, { id: "majors", name: "Majors", symbols: ["EURUSD"] });
    setActiveGroup(OWNER, "majors");
    assert.equal(getTwoStepTradingEnabled(OWNER), false, "two-step trading must default to OFF");

    const ea = startSimulatedEa(OWNER, { bid: 1.1, ask: 1.1002, atr: 0.001 });
    const { executor, placedOrders } = makeExecutor();
    const { provider, calls } = makeProvider({
      tickDecision: { action: "BUY", symbol: "EURUSD", confidence: 80, reason: "clean bullish setup", lots: 0.1, sl: 1.09, tp: 1.12 },
    });

    const outcome = await runAutonomousTick({ userId: OWNER, db, executor, provider });
    const { tickCalls, floCalls } = calls();
    assert.equal(floCalls, 0, "Flo must NEVER be consulted while two-step trading is off");
    assert.equal(tickCalls, 1, "exactly one real decision call");
    assert.equal(placedOrders.length, 1, "the trade must fire exactly as decided, with no Flo gate");
    assert.equal(outcome.action, "BUY");
    console.log(`    confirmed: floCalls=${floCalls}, trade placed=${placedOrders.length === 1}, outcome=${outcome.action}`);
    await ea.stop();
  }

  console.log("\n[2] Two-step ON, Flo genuinely DECLINES -- no trade placed, tradeExecute never called, user sees Flo's real reason...\n");
  {
    const OWNER = "user-two-step-decline";
    upsertGroup(OWNER, { id: "majors", name: "Majors", symbols: ["EURUSD"] });
    setActiveGroup(OWNER, "majors");
    setTwoStepTradingEnabled(OWNER, true);
    assert.equal(getTwoStepTradingEnabled(OWNER), true);

    const ea = startSimulatedEa(OWNER, { bid: 1.1, ask: 1.1002, atr: 0.001 });
    const { executor, placedOrders } = makeExecutor();
    const declineReason = "Real structure check shows a confirmed bearish CHoCH against this BUY -- momentum also already exhausted per get_momentum.";
    const { provider, calls } = makeProvider({
      tickDecision: { action: "BUY", symbol: "EURUSD", confidence: 80, reason: "clean bullish setup", lots: 0.1, sl: 1.09, tp: 1.12 },
      floVerdict: { approve: false, reason: declineReason },
    });

    const outcome = await runAutonomousTick({ userId: OWNER, db, executor, provider });
    const { floCalls } = calls();
    assert.equal(floCalls, 1, "Flo must genuinely be consulted exactly once");
    assert.equal(placedOrders.length, 0, "tradeExecute must NEVER fire on a real Flo decline");
    assert.equal(outcome.action, "NONE", "a Flo decline must be treated as a real SKIP");
    assert.ok(outcome.message?.includes(declineReason) || outcome.message?.includes("Real structure check"), `the user must see Flo's real reason (got: "${outcome.message}")`);
    console.log(`    confirmed: no trade placed, outcome.action=${outcome.action}, message="${outcome.message}"`);
    await ea.stop();
  }

  console.log("\n[3] Two-step ON, Flo genuinely APPROVES -- the trade fires through the unmodified execute path, with Flo's real reason in the trade-placed message...\n");
  {
    const OWNER = "user-two-step-approve";
    upsertGroup(OWNER, { id: "majors", name: "Majors", symbols: ["EURUSD"] });
    setActiveGroup(OWNER, "majors");
    setTwoStepTradingEnabled(OWNER, true);

    const ea = startSimulatedEa(OWNER, { bid: 1.1, ask: 1.1002, atr: 0.001 });
    const { executor, placedOrders } = makeExecutor();
    const approveReason = "get_structure and get_order_blocks both confirm a genuine bullish OB reaction -- real setup, approving.";
    const { provider, calls } = makeProvider({
      tickDecision: { action: "BUY", symbol: "EURUSD", confidence: 80, reason: "clean bullish setup", lots: 0.1, sl: 1.09, tp: 1.12 },
      floVerdict: { approve: true, reason: approveReason },
    });

    const outcome = await runAutonomousTick({ userId: OWNER, db, executor, provider });
    const { floCalls } = calls();
    assert.equal(floCalls, 1);
    assert.equal(placedOrders.length, 1, "the trade must genuinely fire once Flo approves");
    assert.equal(outcome.action, "BUY");
    assert.ok(outcome.message?.includes("Flo reviewed and approved"), `trade-placed message must note Flo's review (got: "${outcome.message}")`);
    assert.ok(outcome.message?.includes("approving") || outcome.message?.includes("real setup"), `trade-placed message must carry Flo's real reason (got: "${outcome.message}")`);
    console.log(`    confirmed: trade placed, message="${outcome.message}"`);
    await ea.stop();
  }

  console.log("\n[4] Limit/stop -> market conversion: all 4 pending types, both the 'already passed' (converts) and 'not yet passed' (unconverted, regression) cases...\n");
  {
    // Real live price fixed at bid=1.1000 for every case below.
    const LIVE = 1.1;
    const cases: { action: "BUY_LIMIT" | "SELL_LIMIT" | "BUY_STOP" | "SELL_STOP"; entryPassed: number; entryNotPassed: number; expectedMarketType: "buy" | "sell" }[] = [
      // BUY_LIMIT waits for a dip TO entry (entry must be BELOW live price to still be valid).
      { action: "BUY_LIMIT", entryPassed: 1.105, entryNotPassed: 1.095, expectedMarketType: "buy" },
      // SELL_LIMIT waits for a rally TO entry (entry must be ABOVE live price to still be valid).
      { action: "SELL_LIMIT", entryPassed: 1.095, entryNotPassed: 1.105, expectedMarketType: "sell" },
      // BUY_STOP waits for a breakout ABOVE entry (entry must be ABOVE live price to still be valid).
      { action: "BUY_STOP", entryPassed: 1.095, entryNotPassed: 1.105, expectedMarketType: "buy" },
      // SELL_STOP waits for a breakdown BELOW entry (entry must be BELOW live price to still be valid).
      { action: "SELL_STOP", entryPassed: 1.105, entryNotPassed: 1.095, expectedMarketType: "sell" },
    ];

    for (const c of cases) {
      // Already passed -> converts to market, sl/tp unchanged.
      {
        const OWNER = `user-convert-${c.action.toLowerCase()}-passed`;
        upsertGroup(OWNER, { id: "majors", name: "Majors", symbols: ["EURUSD"] });
        setActiveGroup(OWNER, "majors");
        const ea = startSimulatedEa(OWNER, { bid: LIVE, ask: LIVE + 0.0002, atr: 0.001 });
        const { executor, placedOrders } = makeExecutor();
        const sl = c.expectedMarketType === "buy" ? 1.09 : 1.11;
        const tp = c.expectedMarketType === "buy" ? 1.12 : 1.08;
        const { provider } = makeProvider({
          tickDecision: { action: c.action, symbol: "EURUSD", entry: c.entryPassed, confidence: 80, reason: "test conversion", lots: 0.1, sl, tp },
        });
        const outcome = await runAutonomousTick({ userId: OWNER, db, executor, provider });
        assert.equal(placedOrders.length, 1, `${c.action} (passed): a market order must still fire`);
        const placed = placedOrders[0];
        assert.equal(placed.type, c.expectedMarketType, `${c.action} with entry ${c.entryPassed} already reached/passed by live price ${LIVE} must convert to market ${c.expectedMarketType} (got ${placed.type})`);
        assert.equal(placed.price, undefined, `${c.action} converted to market must not carry the stale pending price`);
        assert.equal(placed.sl, sl, `${c.action} conversion must keep sl exactly as decided`);
        assert.equal(placed.tp, tp, `${c.action} conversion must keep tp exactly as decided`);
        assert.ok(outcome.message?.includes("placed as market"), `trade-placed message must note the conversion (got: "${outcome.message}")`);
        console.log(`    ${c.action} entry=${c.entryPassed} (passed) -> ${placed.type}, sl=${placed.sl}, tp=${placed.tp} -- confirmed`);
        await ea.stop();
      }

      // Not yet passed -> placed exactly as decided, unconverted (regression, the normal common case).
      {
        const OWNER = `user-convert-${c.action.toLowerCase()}-notpassed`;
        upsertGroup(OWNER, { id: "majors", name: "Majors", symbols: ["EURUSD"] });
        setActiveGroup(OWNER, "majors");
        const ea = startSimulatedEa(OWNER, { bid: LIVE, ask: LIVE + 0.0002, atr: 0.001 });
        const { executor, placedOrders } = makeExecutor();
        const sl = c.expectedMarketType === "buy" ? 1.09 : 1.11;
        const tp = c.expectedMarketType === "buy" ? 1.12 : 1.08;
        const { provider } = makeProvider({
          // The pullback scalp is optional: asked for on the SELL_LIMIT, not on the BUY_LIMIT.
          tickDecision: { action: c.action, symbol: "EURUSD", entry: c.entryNotPassed, confidence: 80, reason: "test no conversion", lots: 0.1, sl, tp, ...(c.action === "SELL_LIMIT" ? { pullbackScalp: {} } : {}) },
        });
        const outcome = await runAutonomousTick({ userId: OWNER, db, executor, provider });
        // A waiting LIMIT opens its pullback scalp only when asked for (two positions, TP1 = the limit
        // price exactly, TP2 past it); without it, or on a STOP order, just the order.
        const isLimit = c.action === "SELL_LIMIT";
        assert.equal(placedOrders.length, isLimit ? 3 : 1, `${c.action} (not passed): the pending order must still fire${isLimit ? ", with its pullback scalp" : ""}`);
        const placed = placedOrders[0];
        if (isLimit) {
          const scalpSide = c.action === "SELL_LIMIT" ? "buy" : "sell";
          const [a, b] = placedOrders.slice(1);
          assert.deepEqual([a.type, b.type], [scalpSide, scalpSide], `${c.action}: the scalp goes the other way (${scalpSide})`);
          assert.equal(a.tp, c.entryNotPassed, `${c.action}: scalp TP1 is exactly the limit price`);
          assert.ok(c.action === "SELL_LIMIT" ? b.tp! > c.entryNotPassed : b.tp! < c.entryNotPassed, `${c.action}: scalp TP2 is past the limit`);
          assert.ok(outcome.message?.includes("Pullback scalp"), `the trade message reports the scalp (got: "${outcome.message}")`);
        }
        assert.equal(placed.type, c.action.toLowerCase(), `${c.action} with entry ${c.entryNotPassed} NOT yet reached by live price ${LIVE} must be placed exactly as decided, unconverted (got ${placed.type})`);
        assert.equal(placed.price, c.entryNotPassed, `${c.action} unconverted must keep its real entry price`);
        assert.equal(placed.sl, sl);
        assert.equal(placed.tp, tp);
        assert.ok(!outcome.message?.includes("placed as market"), `an unconverted pending order's message must NOT claim a market conversion (got: "${outcome.message}")`);
        console.log(`    ${c.action} entry=${c.entryNotPassed} (not passed) -> ${placed.type} (unconverted) -- confirmed`);
        await ea.stop();
      }
    }
  }

  console.log("\n=== ALL ASSERTIONS PASSED ===");
}

main()
  .then(() => {
    globalThis.fetch = realFetch;
    rmSync(workDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    globalThis.fetch = realFetch;
    rmSync(workDir, { recursive: true, force: true });
    console.error(err);
    process.exit(1);
  });
