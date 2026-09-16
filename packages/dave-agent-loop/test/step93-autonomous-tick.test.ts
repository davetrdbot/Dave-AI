import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { DaveDatabase } from "@dave/db";
import type { Provider, CompletionRequest, CompletionResult, ToolCall } from "@dave/brain";
import type { TradeExecutor } from "@dave/trading";
import { upsertGroup, setActiveGroup, setActivePairSymbol, setRiskMode, setConfidenceThreshold, setAutoApproveBelowThreshold, listPendingTradeApprovals } from "@dave/trading";
import { getOrCreateEaWebhook, createEaWebhookServer, type EaCommand } from "@dave/ea-bridge";
import { listTradesSince } from "@dave/feedback";
import { runAutonomousTick } from "../src/autonomous-tick.js";
import { getCursorPosition } from "../src/autonomous-tick-state.js";
import { summarizeReason } from "../src/trade-notifications.js";

/**
 * Real proof for the plan's core fix: the autonomous cycle's decision mechanism replaced with a
 * single structured tool call per tick (modeled on the user's own former bot's tickOne()), not
 * an open-ended agentic loop. Proves, end to end through the REAL functions this module actually
 * calls (evaluateConfidenceGate, tradeExecute, logTrade, huntForSetup, ask-user) -- not
 * reimplemented in the test: a real BUY fires and is logged via a genuine tool call, a
 * low-confidence trade queues instead of firing, an already-open symbol is skipped before any
 * model call happens at all, ASK genuinely creates a message without deadlocking, the rolling
 * last-3-decisions context genuinely carries across ticks, and the round-robin cursor genuinely
 * advances through a whole group regardless of decision outcome.
 */

console.log("=== Real proof: the autonomous tick's structured tool-call decision mechanism ===\n");

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

/** Mock provider returning a real tool call each time, matching how autonomous-tick.ts actually
 *  reads a decision (result.toolCalls, not free text) -- proves the real tool-call path, not the
 *  text-JSON fallback. */
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

/** Mock provider returning plain text (no toolCalls) -- proves the text-JSON fallback path still
 *  works for a provider with weaker tool-calling support. */
function mockTextProvider(responses: string[]): { provider: Provider; calls: CompletionRequest[] } {
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

  console.log("[1] A real BUY decision (via a genuine tool call) fires a real trade_execute and is auto-logged -- SL/TP auto mode, model computes both, and the tool schema genuinely required them...\n");
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
    const { provider, calls } = mockToolProvider([
      { action: "BUY", symbol: "EURUSD", sl: 1.08, tp: 1.095, lots: 0.05, confidence: 78, reason: "BOS + OB retest + RSI turning up" },
    ]);
    try {
      const outcome = await runAutonomousTick({ userId: OWNER, db, executor, provider });
      console.log(`    real outcome: ${JSON.stringify(outcome)}`);
      assert.equal(outcome.action, "BUY");
      assert.deepEqual(placed, [{ symbol: "EURUSD", type: "buy" }]);
      assert.equal(calls.length, 1, "exactly ONE model call for the whole decision -- no multi-turn tool loop");
      assert.equal(calls[0].tools?.length, 1, "a real single decision tool must be attached");
      const schema = calls[0].tools![0].parameters as { required: string[] };
      assert.ok(schema.required.includes("sl") && schema.required.includes("tp"), "sl/tp must be REQUIRED in the schema when risk mode is auto");
      // Real bug fixed (confirmed LIVE: a genuinely good BUY decision got silently thrown away
      // as "no valid lot size" because lots was never required in the schema -- lot mode here is
      // "off", the exact mode that bug hit, since the order-building logic only ever uses a fixed
      // lot value when mode is "on"; every other mode needs the model to supply one.
      assert.ok(schema.required.includes("lots"), "lots must be REQUIRED in the schema whenever lot mode isn't 'on' -- otherwise a real decision can silently have no size to trade with");

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

    const { provider, calls } = mockToolProvider([{ action: "SKIP", reason: "should never be called" }]);
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
    const { provider } = mockToolProvider([{ action: "SELL", symbol: "USDJPY", sl: 148.5, tp: 147, lots: 0.02, confidence: 45, reason: "weak momentum" }]);
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
    const { provider } = mockToolProvider([{ action: "ASK", question: "H4 says buy but M15 just printed a CHoCH sell -- which do you want me to weight?", options: ["Follow H4", "Follow M15", "Skip"], reason: "conflicting timeframes" }]);
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

  console.log("\n[5] The rolling last-3-decisions context genuinely carries across ticks, not a growing transcript (text-JSON fallback path, for a provider that doesn't return a real tool call)...\n");
  {
    const OWNER5 = "user-autonomous-tick-5";
    upsertGroup(OWNER5, { id: "majors", name: "Majors", symbols: ["NZDUSD"] });
    setActiveGroup(OWNER5, "majors");
    const executor: TradeExecutor = { openOrder: async () => ({ ticket: "T" }), modifyOrder: async () => {}, closePosition: async () => ({ closedLots: 0, remainingLots: 0 }), deletePendingOrder: async () => {}, listOpenPositions: async () => [], listPendingOrders: async () => [] };
    const ea = startSimulatedEa(OWNER5, { NZDUSD: { bid: 0.59, ask: 0.5902 } });
    const { provider, calls } = mockTextProvider([
      '{"action":"SKIP","reason":"first real skip reason"}',
      '{"action":"SKIP","reason":"second real skip reason"}',
    ]);
    try {
      await runAutonomousTick({ userId: OWNER5, db, executor, provider });
      await new Promise((r) => setTimeout(r, 100));
      await runAutonomousTick({ userId: OWNER5, db, executor, provider });
      const secondCallContext = calls[1].messages.find((m) => m.role === "user")!.content as string;
      console.log(`    real second-tick context includes: ${secondCallContext.includes("first real skip reason") ? "the first tick's real decision" : "NOTHING -- BUG"}`);
      assert.ok(secondCallContext.includes("first real skip reason"), "the second tick's context must genuinely include the first tick's real decision");
    } finally {
      await ea.stop();
    }
  }

  console.log("\n[6] The round-robin cursor genuinely advances through a whole group regardless of decision outcome (BUY, SKIP, ASK alike), never getting stuck re-picking the same first-eligible symbol...\n");
  {
    const OWNER6 = "user-autonomous-tick-6";
    upsertGroup(OWNER6, { id: "majors", name: "Majors", symbols: ["EURUSD", "GBPUSD", "USDJPY"] });
    setActiveGroup(OWNER6, "majors");
    setRiskMode(OWNER6, "sl", "off");
    setRiskMode(OWNER6, "tp", "off");
    setRiskMode(OWNER6, "lot", "on", 0.01);
    const executor: TradeExecutor = { openOrder: async () => ({ ticket: "T" }), modifyOrder: async () => {}, closePosition: async () => ({ closedLots: 0, remainingLots: 0 }), deletePendingOrder: async () => {}, listOpenPositions: async () => [], listPendingOrders: async () => [] };
    const ea = startSimulatedEa(OWNER6, { EURUSD: { bid: 1.08, ask: 1.0802 }, GBPUSD: { bid: 1.27, ask: 1.2702 }, USDJPY: { bid: 148, ask: 148.02 } });
    const { provider } = mockToolProvider([
      { action: "SKIP", reason: "nothing on symbol 1" },
      { action: "BUY", confidence: 90, reason: "real setup on symbol 2" },
      { action: "SKIP", reason: "nothing on symbol 3" },
    ]);
    try {
      const seenCursors: number[] = [];
      for (let i = 0; i < 3; i++) {
        const before = getCursorPosition(OWNER6);
        seenCursors.push(before.symbolCursor);
        const outcome = await runAutonomousTick({ userId: OWNER6, db, executor, provider });
        const after = getCursorPosition(OWNER6);
        console.log(`    tick ${i + 1}: cursor was ${before.symbolCursor} (symbol=${outcome.symbol ?? "n/a"}, action=${outcome.action}), cursor now ${after.symbolCursor}`);
      }
      assert.deepEqual(seenCursors, [0, 1, 2], "the cursor must visit every index once per lap, in order, regardless of SKIP/BUY outcome");
      const wrapped = getCursorPosition(OWNER6);
      assert.equal(wrapped.symbolCursor, 0, "cursor wraps back to 0 after a full lap");
    } finally {
      await ea.stop();
    }
  }

  console.log("\n[7] Real MT5 comment is short and structured (Dave:<confidence>% <strategyTag>), never a slice of the raw reasoning text -- and the full push-notification reason is the model's real, untruncated `reason`, never run through summarizeReason...\n");
  {
    const OWNER7 = "user-autonomous-tick-7";
    upsertGroup(OWNER7, { id: "majors", name: "Majors", symbols: ["EURUSD"] });
    setActiveGroup(OWNER7, "majors");
    setRiskMode(OWNER7, "sl", "off");
    setRiskMode(OWNER7, "tp", "off");
    setRiskMode(OWNER7, "lot", "on", 0.05);
    setConfidenceThreshold(OWNER7, 50);
    setAutoApproveBelowThreshold(OWNER7, true);

    const longReason =
      "Multi-timeframe alignment is genuinely strong here: H4 shows a clean bullish market structure shift off the weekly demand zone, H1 printed a bullish order block retest with a clear break of structure, and M15 confirms with a liquidity sweep below the prior swing low followed by a strong displacement candle back through structure. RSI is turning up off oversold on both H1 and M15, and volume on the displacement candle was well above the 20-period average, which is real confirmation this isn't a low-conviction retail trap. Risk is well-defined against the sweep low with a clean 1:3 R:R into the next real liquidity pool above.";

    const placedOrders: { symbol: string; type: string; comment?: string }[] = [];
    const executor: TradeExecutor = {
      openOrder: async (order) => { placedOrders.push({ symbol: order.symbol, type: order.type, comment: order.comment }); return { ticket: "T-EURUSD-7" }; },
      modifyOrder: async () => {}, closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
      deletePendingOrder: async () => {}, listOpenPositions: async () => [], listPendingOrders: async () => [],
    };
    const ea = startSimulatedEa(OWNER7, { EURUSD: { bid: 1.085, ask: 1.0852 } });
    const { provider } = mockToolProvider([
      { action: "BUY", symbol: "EURUSD", confidence: 67, reason: longReason, strategyTag: "Bullish engulfing" },
    ]);
    try {
      const outcome = await runAutonomousTick({ userId: OWNER7, db, executor, provider });
      console.log(`    real MT5 comment: ${JSON.stringify(placedOrders[0]?.comment)}`);
      assert.equal(placedOrders.length, 1);
      assert.equal(placedOrders[0].comment, "Dave:67% Bullish engulfing", "the real MT5 comment must be short and structured, not a slice of the reasoning text");
      assert.ok((placedOrders[0].comment?.length ?? 0) <= 28, "MT5 comment must stay within the conservative 28-char cap");

      console.log(`    real Telegram message length: ${outcome.message?.length}, contains full reason: ${outcome.message?.includes(longReason)}`);
      assert.ok(outcome.message?.includes(longReason), "the real Telegram trade-placed message must contain the model's FULL, untruncated reason verbatim, not a summarized/shortened version");
      assert.ok(!outcome.message?.includes(summarizeReason(longReason)) || summarizeReason(longReason) === longReason, "sanity: the message must not merely be carrying the summarized text");
    } finally {
      await ea.stop();
    }
  }

  console.log("\n[7b] A strategyTag longer than the 28-char cap is correctly truncated, and a genuinely missing strategyTag falls back to 'setup' rather than leaving a malformed comment...\n");
  {
    const OWNER7B = "user-autonomous-tick-7b";
    upsertGroup(OWNER7B, { id: "majors", name: "Majors", symbols: ["GBPUSD"] });
    setActiveGroup(OWNER7B, "majors");
    setRiskMode(OWNER7B, "sl", "off");
    setRiskMode(OWNER7B, "tp", "off");
    setRiskMode(OWNER7B, "lot", "on", 0.05);
    setConfidenceThreshold(OWNER7B, 50);
    setAutoApproveBelowThreshold(OWNER7B, true);

    const placedOrders: { comment?: string }[] = [];
    const executor: TradeExecutor = {
      openOrder: async (order) => { placedOrders.push({ comment: order.comment }); return { ticket: "T-GBPUSD-7b" }; },
      modifyOrder: async () => {}, closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
      deletePendingOrder: async () => {}, listOpenPositions: async () => [], listPendingOrders: async () => [],
    };
    const ea = startSimulatedEa(OWNER7B, { GBPUSD: { bid: 1.27, ask: 1.2702 } });
    const { provider } = mockToolProvider([
      { action: "BUY", symbol: "GBPUSD", confidence: 72, reason: "real long reason text", strategyTag: "A genuinely very long strategy tag that goes way past the safe MT5 comment length" },
    ]);
    try {
      await runAutonomousTick({ userId: OWNER7B, db, executor, provider });
      console.log(`    real MT5 comment (long tag): ${JSON.stringify(placedOrders[0]?.comment)} (length ${placedOrders[0]?.comment?.length})`);
      assert.ok((placedOrders[0].comment?.length ?? 0) <= 28, "a long strategyTag must still be truncated to the 28-char cap, never left malformed");
      assert.equal(placedOrders[0].comment, "Dave:72% A genuinely very lo".slice(0, 28));
    } finally {
      await ea.stop();
    }

    const OWNER7C = "user-autonomous-tick-7c";
    upsertGroup(OWNER7C, { id: "majors", name: "Majors", symbols: ["AUDCAD"] });
    setActiveGroup(OWNER7C, "majors");
    setRiskMode(OWNER7C, "sl", "off");
    setRiskMode(OWNER7C, "tp", "off");
    setRiskMode(OWNER7C, "lot", "on", 0.05);
    setConfidenceThreshold(OWNER7C, 50);
    setAutoApproveBelowThreshold(OWNER7C, true);
    const placedNoTag: { comment?: string }[] = [];
    const executorNoTag: TradeExecutor = {
      openOrder: async (order) => { placedNoTag.push({ comment: order.comment }); return { ticket: "T-AUDCAD-7c" }; },
      modifyOrder: async () => {}, closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
      deletePendingOrder: async () => {}, listOpenPositions: async () => [], listPendingOrders: async () => [],
    };
    const ea2 = startSimulatedEa(OWNER7C, { AUDCAD: { bid: 0.9, ask: 0.9002 } });
    const { provider: providerNoTag } = mockToolProvider([{ action: "BUY", symbol: "AUDCAD", confidence: 55, reason: "no tag given here" }]);
    try {
      await runAutonomousTick({ userId: OWNER7C, db, executor: executorNoTag, provider: providerNoTag });
      console.log(`    real MT5 comment (no strategyTag given): ${JSON.stringify(placedNoTag[0]?.comment)}`);
      assert.equal(placedNoTag[0].comment, "Dave:55% setup", "a genuinely missing strategyTag must fall back to 'setup', never leave the comment malformed");
    } finally {
      await ea2.stop();
    }
  }

  console.log("\n[8] summarizeReason itself is unaffected for the other real call sites that still legitimately use it (e.g. DELETE_TICKET's short notice)...\n");
  {
    const OWNER8 = "user-autonomous-tick-8";
    // Real ticket to close lives on GBPUSD; the active group is EURJPY -- a different symbol --
    // so the cursor genuinely picks EURJPY (no open position on it) and requests a real decision,
    // matching the reference pattern step97's own DELETE_TICKET proof uses (an open-position
    // symbol is otherwise skipped before any model call, per block [2] above).
    upsertGroup(OWNER8, { id: "majors", name: "Majors", symbols: ["EURJPY"] });
    setActiveGroup(OWNER8, "majors");
    const longReason =
      "This position no longer makes sense given the real shift in structure. Price has broken back below the level that originally justified the entry, momentum has clearly reversed on the lower timeframes, and holding further would just be hoping rather than trading a real edge, so closing it now protects the account instead of giving back more of the open profit than necessary.";
    const executor: TradeExecutor = {
      openOrder: async () => ({ ticket: "T" }), modifyOrder: async () => {},
      closePosition: async () => ({ closedLots: 0.1, remainingLots: 0 }),
      deletePendingOrder: async () => {},
      listOpenPositions: async () => [{ ticket: "T-DEL-8", symbol: "GBPUSD", type: "buy", lots: 0.1, openPrice: 1.27 }],
      listPendingOrders: async () => [],
    };
    const webhook = getOrCreateEaWebhook(OWNER8);
    const server = createEaWebhookServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => {
      const body = JSON.stringify({ type: "heartbeat", account: "1", balance: 1000, positions: [{ ticket: "T-DEL-8", symbol: "GBPUSD", type: "buy", lots: 0.1, openPrice: 1.27 }], pendingOrders: [] });
      const req = request({ hostname: "127.0.0.1", port, path: webhook.path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => { res.on("data", () => {}); res.on("end", () => resolve()); });
      req.on("error", reject); req.write(body); req.end();
    });
    server.close();

    const ea = startSimulatedEa(OWNER8, { EURJPY: { bid: 160, ask: 160.02 } });
    const { provider } = mockToolProvider([{ action: "DELETE_TICKET", ticket: "T-DEL-8", reason: longReason }]);
    let outcome;
    try {
      outcome = await runAutonomousTick({ userId: OWNER8, db, executor, provider });
    } finally {
      await ea.stop();
    }
    console.log(`    real DELETE_TICKET message: ${outcome.message}`);
    const expectedSummary = summarizeReason(longReason);
    assert.ok(outcome.message?.includes(expectedSummary), "DELETE_TICKET's message must still use summarizeReason's real short summary -- unaffected by Part A's trade-placed-message-only change");
    assert.ok(!outcome.message?.includes(longReason), "DELETE_TICKET's message must NOT carry the full raw reason -- summarizeReason is still doing real work here");

    // And a direct, isolated proof that summarizeReason's own behavior (2 sentences / 220 chars,
    // word-boundary truncation with a trailing ellipsis) is unchanged.
    assert.equal(summarizeReason("One sentence. Two sentence. Three sentence should be dropped."), "One sentence. Two sentence.");
    const overLong = "A".repeat(300);
    assert.equal(summarizeReason(overLong).endsWith("…"), true, "summarizeReason must still cap and ellipsize a genuinely over-length single \"sentence\"");
  }

  console.log("\n[9] Real bug fixed (user, live: a trade fired at a literal 0% confidence -- \"what's the point of placing the market then\"). A decision missing `confidence` must be hard-rejected, never silently treated as a real 0% and auto-approved, even with autoApproveBelowThreshold=true and a low threshold...\n");
  {
    const OWNER9 = "user-autonomous-tick-9";
    upsertGroup(OWNER9, { id: "majors", name: "Majors", symbols: ["EURCHF"] });
    setActiveGroup(OWNER9, "majors");
    setRiskMode(OWNER9, "sl", "off");
    setRiskMode(OWNER9, "tp", "off");
    setRiskMode(OWNER9, "lot", "on", 0.01);
    setConfidenceThreshold(OWNER9, 1);
    setAutoApproveBelowThreshold(OWNER9, true);

    const placed: string[] = [];
    const executor: TradeExecutor = {
      openOrder: async (o) => { placed.push(o.symbol); return { ticket: "T" }; },
      modifyOrder: async () => {}, closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
      deletePendingOrder: async () => {}, listOpenPositions: async () => [], listPendingOrders: async () => [],
    };
    const ea = startSimulatedEa(OWNER9, { EURCHF: { bid: 0.95, ask: 0.9502 } });
    // Real tool call with `confidence` genuinely omitted -- exactly what coerceDecision produces
    // when the model's JSON leaves the field out or returns something non-numeric for it.
    const { provider, calls } = mockToolProvider([{ action: "BUY", symbol: "EURCHF", reason: "malformed decision, no real confidence given" }]);
    try {
      const outcome = await runAutonomousTick({ userId: OWNER9, db, executor, provider });
      console.log(`    real outcome: ${JSON.stringify(outcome)}, real orders placed: ${JSON.stringify(placed)}`);
      assert.equal(outcome.action, "NONE", "a missing-confidence decision must be discarded as a real SKIP, never proceed as a trade");
      assert.equal(placed.length, 0, "a missing-confidence decision must NEVER auto-fire, even with autoApproveBelowThreshold=true and a threshold of 1%");
      assert.equal(listPendingTradeApprovals(OWNER9).length, 0, "it must not even queue for approval -- it's a malformed decision, not a real low score");

      const schema = calls[0].tools![0].parameters as { required: string[] };
      assert.ok(schema.required.includes("confidence"), "confidence must be REQUIRED on the decision tool's schema -- the model must not be able to omit it in the first place");
      console.log(`    real schema.required: ${JSON.stringify(schema.required)}`);
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
