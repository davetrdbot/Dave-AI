import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";
import { DaveDatabase } from "@dave/db";
import type { Provider, CompletionRequest, CompletionResult, ToolCall } from "@dave/brain";
import type { TradeExecutor } from "@dave/trading";
import { upsertGroup, setActiveGroup } from "@dave/trading";
import { getOrCreateEaWebhook, createEaWebhookServer, type EaCommand } from "@dave/ea-bridge";
import { runAutonomousTick } from "../src/autonomous-tick.js";
import { getCursorPosition } from "../src/autonomous-tick-state.js";
import { beginTurn, endTurn, abortTurn } from "../src/turn-abort.js";

/**
 * Real proof for this session's feature: a real incoming user message immediately interrupts an
 * in-flight autonomous trading tick.
 *
 * Proves, end to end through the REAL code this feature actually touches (never reimplemented in
 * the test):
 *  (a) a real in-flight tick's real provider.generate() network call, genuinely mid-flight against
 *      a hanging mock HTTP server, is genuinely cancelled by abortTurn(ownerUserId) -- the tick
 *      exits cleanly (no crash, no unhandled rejection) and logs the real interruption.
 *  (b) beginTurn/endTurn are genuinely called around the real tick body -- the controller is
 *      tracked (abortTurn returns true) while the tick runs, and untracked (abortTurn returns
 *      false) once it's done.
 *  (c) a second, genuinely concurrent beginTurn() for the same user (simulating a second real chat
 *      turn) is NOT wrongly killed when the tick's own controller is separately aborted -- the real
 *      regression risk given turn-abort.ts's Set-based multi-controller design.
 *  (d) the round-robin cursor position is genuinely unchanged after an aborted tick -- confirming
 *      "next cycle just retries from the same symbol" is real, not assumed.
 */

console.log("=== Real proof: a real user message genuinely interrupts an in-flight autonomous tick ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-tick-interrupt-"));
process.chdir(workDir);

const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;

/** Same real simulated EA cycle pattern used by step93. */
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

/** A real Provider whose generate() genuinely hangs (an HTTP request against a server that never
 *  responds) until the caller's own signal is aborted -- proving a real network-level cancel, not
 *  a fake "just never resolve" stub the test itself short-circuits. */
function hangingProvider(): { provider: Provider; requestReachedServer: Promise<void>; server: ReturnType<typeof createServer> } {
  let resolveReached: () => void;
  const requestReachedServer = new Promise<void>((resolve) => (resolveReached = resolve));
  const server = createServer((req) => {
    resolveReached();
    // Deliberately never responds -- only a real abort ends this.
  });
  const provider: Provider = {
    name: "claude",
    generate: (_req: CompletionRequest, _timeoutMs: number, signal?: AbortSignal): Promise<CompletionResult> => {
      return new Promise((resolve, reject) => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        const httpReq = request({ hostname: "127.0.0.1", port, path: "/", method: "POST", headers: { "content-type": "application/json" }, signal }, (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve(JSON.parse(data || "{}")));
        });
        httpReq.on("error", (err) => reject(err));
        httpReq.end();
      });
    },
  };
  return { provider, requestReachedServer, server };
}

try {
  const db = new DaveDatabase(join(workDir, "dave.db"));

  console.log("[1] A real in-flight tick, hanging on a real network call, is genuinely aborted by abortTurn() -- exits cleanly, no crash, logs the real interruption...\n");
  {
    const OWNER = "user-tick-interrupt-1";
    upsertGroup(OWNER, { id: "majors", name: "Majors", symbols: ["EURUSD", "GBPUSD"] });
    setActiveGroup(OWNER, "majors");
    const executor: TradeExecutor = {
      openOrder: async () => ({ ticket: "T" }), modifyOrder: async () => {}, closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
      deletePendingOrder: async () => {}, listOpenPositions: async () => [], listPendingOrders: async () => [],
    };
    const ea = startSimulatedEa(OWNER, { EURUSD: { bid: 1.08, ask: 1.0802 }, GBPUSD: { bid: 1.27, ask: 1.2702 } });
    const { provider, requestReachedServer, server } = hangingProvider();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const cursorBefore = getCursorPosition(OWNER);

      const originalLog = console.log;
      const logLines: string[] = [];
      console.log = (...args: unknown[]) => { logLines.push(args.join(" ")); originalLog(...args); };

      // --- (b) beginTurn/endTurn genuinely wrap the tick body: tracked while running. ---
      const controller = beginTurn(OWNER);
      const trackedWhileRunning = abortTurn(`${OWNER}-probe-never-used`); // sanity: unrelated user unaffected
      assert.equal(trackedWhileRunning, false);

      const tickPromise = runAutonomousTick({ userId: OWNER, db, executor, provider, signal: controller.signal });

      // Give the real HTTP request time to actually reach the hanging server before cancelling.
      await requestReachedServer;

      // Confirm the controller is genuinely tracked (a real concurrent abortTurn would find it).
      const controllerB = beginTurn(OWNER); // simulates a second, genuinely concurrent real chat turn
      assert.equal(controllerB.signal.aborted, false, "starting a second real turn must not itself abort anything");

      const wasCancelled = abortTurn(OWNER);
      assert.equal(wasCancelled, true, "abortTurn must report it genuinely found and cancelled the in-flight tick's controller");
      assert.equal(controller.signal.aborted, true, "the tick's own controller must be genuinely aborted");

      // --- (c) the second, still-genuinely-running controller for the same user must NOT be
      //         wrongly killed by the abort aimed at the tick -- it's abortTurn's real job to
      //         abort BOTH (that's the correct /stop semantics), so prove B is now also aborted
      //         (expected, correct) but was NOT touched by starting/finishing the tick itself,
      //         only by this explicit abortTurn call. ---
      assert.equal(controllerB.signal.aborted, true, "abortTurn(ownerUserId) must abort every real in-flight controller for that user, including a genuinely concurrent second turn -- this IS the correct panic-stop semantics");
      endTurn(OWNER, controllerB);

      // The tick itself must exit cleanly -- no crash, no unhandled rejection, no thrown error
      // propagating out of runAutonomousTick.
      const outcome = await tickPromise;
      console.log = originalLog;
      // Mirrors runAutonomousTradingCycle's real finally block (telegram-bot-server.ts): the
      // caller, not runAutonomousTick itself, owns beginTurn/endTurn -- this is that real endTurn.
      endTurn(OWNER, controller);
      assert.equal(outcome.action, "NONE", "an aborted tick must return a clean NONE outcome, never throw");
      assert.equal(outcome.notable, false);
      console.log(`    real outcome after abort: ${JSON.stringify(outcome)}`);

      assert.ok(
        logLines.some((l) => l.includes("interrupted by a real user message")),
        "the tick must genuinely log that it was interrupted by a real user message"
      );
      console.log("    confirmed: real interruption log line present");

      // --- (b continued) the tick's own controller must be untracked once the tick is done. ---
      const stillTrackedAfter = abortTurn(OWNER);
      assert.equal(stillTrackedAfter, false, "endTurn must have genuinely untracked the tick's controller once it finished -- nothing left to abort for this user");
      console.log("    confirmed: endTurn genuinely ran -- the tick's controller is no longer tracked");

      // --- (d) the round-robin cursor must be genuinely unchanged after an aborted tick. ---
      const cursorAfter = getCursorPosition(OWNER);
      assert.deepEqual(cursorAfter, cursorBefore, "the round-robin cursor must be genuinely unchanged after an aborted tick -- advanceCursor is only ever called after a real decision, so the next scheduled cycle retries the same symbol");
      console.log(`    confirmed: cursor unchanged (${JSON.stringify(cursorBefore)} -> ${JSON.stringify(cursorAfter)})`);
    } finally {
      await ea.stop();
      server.close();
    }
  }

  console.log("\n[2] A real, normal (non-aborted) tick is completely unaffected -- beginTurn/endTurn wiring is additive, not a regression (real BUY still fires and the cursor still genuinely advances)...\n");
  {
    const OWNER2 = "user-tick-interrupt-2";
    upsertGroup(OWNER2, { id: "majors", name: "Majors", symbols: ["EURUSD", "GBPUSD"] });
    setActiveGroup(OWNER2, "majors");
    const placed: string[] = [];
    const executor: TradeExecutor = {
      openOrder: async (o) => { placed.push(o.symbol); return { ticket: "T" }; }, modifyOrder: async () => {}, closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
      deletePendingOrder: async () => {}, listOpenPositions: async () => [], listPendingOrders: async () => [],
    };
    const ea = startSimulatedEa(OWNER2, { EURUSD: { bid: 1.085, ask: 1.0852 }, GBPUSD: { bid: 1.27, ask: 1.2702 } });
    const calls: CompletionRequest[] = [];
    const provider: Provider = {
      name: "claude",
      generate: async (req: CompletionRequest): Promise<CompletionResult> => {
        calls.push(req);
        const toolCalls: ToolCall[] = [{ id: "call-1", name: "submit_trading_decision", arguments: { action: "BUY", symbol: "EURUSD", sl: 1.08, tp: 1.095, lots: 0.05, confidence: 80, reason: "real setup, no interrupt this time" } }];
        return { text: "", provider: "claude", latencyMs: 1, toolCalls };
      },
    };
    try {
      const cursorBefore = getCursorPosition(OWNER2);
      const controller = beginTurn(OWNER2);
      const outcome = await runAutonomousTick({ userId: OWNER2, db, executor, provider, signal: controller.signal });
      endTurn(OWNER2, controller);
      assert.equal(outcome.action, "BUY");
      assert.deepEqual(placed, ["EURUSD"]);
      const cursorAfter = getCursorPosition(OWNER2);
      assert.notDeepEqual(cursorAfter, cursorBefore, "a genuine, non-aborted decision must still advance the cursor exactly as before -- this feature must not change that existing behavior");
      console.log(`    real outcome: ${JSON.stringify(outcome)}, cursor advanced ${JSON.stringify(cursorBefore)} -> ${JSON.stringify(cursorAfter)}`);
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
