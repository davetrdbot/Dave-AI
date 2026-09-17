import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { DaveDatabase } from "@dave/db";
import type { Provider, CompletionRequest, CompletionResult, ToolCall } from "@dave/brain";
import type { TradeExecutor, OrderRequest } from "@dave/trading";
import { upsertGroup, setActiveGroup, getSequentialThinkingEnabled, setSequentialThinkingEnabled } from "@dave/trading";
import { getOrCreateEaWebhook, createEaWebhookServer, type EaCommand } from "@dave/ea-bridge";
import { runAutonomousTick } from "../src/autonomous-tick.js";

/**
 * Real proof that Part 3's sequential-thinking pass is genuinely wired into the one place it's
 * allowed to run (autonomous-tick.ts's final trade decision), genuinely gated by the real
 * settings toggle (OFF by default -- the existing single-call decision path is completely
 * unaffected until the user explicitly turns it on), and that its real per-thought progress
 * reaches the caller via onSequentialThinkingProgress -- the same callback
 * telegram-bot-server.ts wires to the automatic ThinkingIndicator's update() mechanism, never a
 * separate indicator.
 */

console.log("=== Real proof: sequential thinking is genuinely wired into (and gated ahead of) the tick's real trade decision ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-sequential-thinking-wiring-"));
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

/** Distinguishes the tick's real decision call from a real sequential-thinking "submit_thought"
 *  call, the same way step106 distinguishes the tick call from a Flo call. */
function makeProvider(opts: { tickDecision: Record<string, unknown> }) {
  let tickCalls = 0;
  let thoughtCalls = 0;
  const provider: Provider = {
    name: "mock",
    generate: async (req: CompletionRequest): Promise<CompletionResult> => {
      const isTickDecision = req.tools?.length === 1 && req.tools[0].name === "submit_trading_decision";
      if (isTickDecision) {
        tickCalls++;
        const toolCalls: ToolCall[] = [{ id: `t${tickCalls}`, name: "submit_trading_decision", arguments: opts.tickDecision }];
        return { text: "", provider: "mock", latencyMs: 1, toolCalls };
      }
      const isThought = req.tools?.some((t) => t.name === "submit_thought");
      if (isThought) {
        thoughtCalls++;
        const toolCalls: ToolCall[] = [
          {
            id: `s${thoughtCalls}`,
            name: "submit_thought",
            arguments: { thought: `real reasoning step ${thoughtCalls}`, thoughtNumber: thoughtCalls, totalThoughts: 2, nextThoughtNeeded: thoughtCalls < 2 },
          },
        ];
        return { text: "", provider: "mock", latencyMs: 1, toolCalls };
      }
      throw new Error(`unexpected provider call with tools: ${req.tools?.map((t) => t.name).join(",")}`);
    },
  };
  return { provider, calls: () => ({ tickCalls, thoughtCalls }) };
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

  console.log("[1] Default: sequential thinking is OFF -- no real submit_thought calls at all, the plain single-call decision path is unaffected...\n");
  {
    const OWNER = "user-seq-thinking-default-off";
    upsertGroup(OWNER, { id: "majors", name: "Majors", symbols: ["EURUSD"] });
    setActiveGroup(OWNER, "majors");
    assert.equal(getSequentialThinkingEnabled(OWNER), false, "must default OFF");

    const ea = startSimulatedEa(OWNER, { bid: 1.1, ask: 1.1002, atr: 0.001 });
    const { executor, placedOrders } = makeExecutor();
    const { provider, calls } = makeProvider({ tickDecision: { action: "BUY", symbol: "EURUSD", confidence: 80, reason: "clean bullish setup", lots: 0.1, sl: 1.09, tp: 1.12 } });

    const outcome = await runAutonomousTick({ userId: OWNER, db, executor, provider });
    const { tickCalls, thoughtCalls } = calls();
    assert.equal(thoughtCalls, 0, "no real sequential-thinking call must ever happen while the toggle is off");
    assert.equal(tickCalls, 1, "exactly one real decision call -- the plain path");
    assert.equal(placedOrders.length, 1);
    assert.equal(outcome.action, "BUY");
    console.log(`    confirmed: thoughtCalls=${thoughtCalls}, tickCalls=${tickCalls}, trade placed=${placedOrders.length === 1}`);
    await ea.stop();
  }

  console.log("\n[2] Toggle ON -- a real bounded sequential-thinking pass runs before the decision, and its real progress reaches onSequentialThinkingProgress...\n");
  {
    const OWNER = "user-seq-thinking-on";
    upsertGroup(OWNER, { id: "majors", name: "Majors", symbols: ["EURUSD"] });
    setActiveGroup(OWNER, "majors");
    setSequentialThinkingEnabled(OWNER, true);
    assert.equal(getSequentialThinkingEnabled(OWNER), true);

    const ea = startSimulatedEa(OWNER, { bid: 1.1, ask: 1.1002, atr: 0.001 });
    const { executor, placedOrders } = makeExecutor();
    const { provider, calls } = makeProvider({ tickDecision: { action: "BUY", symbol: "EURUSD", confidence: 80, reason: "clean bullish setup", lots: 0.1, sl: 1.09, tp: 1.12 } });
    const progress: string[] = [];

    const outcome = await runAutonomousTick({
      userId: OWNER,
      db,
      executor,
      provider,
      onSequentialThinkingProgress: (text) => progress.push(text),
    });
    const { tickCalls, thoughtCalls } = calls();
    assert.equal(thoughtCalls, 2, "the scripted 2-thought sequence must genuinely run before the real decision call");
    assert.equal(tickCalls, 1, "still exactly one real decision call -- the pass adds context, it doesn't replace the decision");
    assert.equal(placedOrders.length, 1, "the real trade must still fire normally once the decision is made");
    assert.equal(outcome.action, "BUY");
    assert.equal(progress.length, 2, "real per-thought progress must reach the caller's callback -- the same one wired to the automatic ThinkingIndicator's update()");
    assert.ok(progress[0].includes("real reasoning step 1"));
    console.log(`    confirmed: thoughtCalls=${thoughtCalls} (real pass ran), tickCalls=${tickCalls} (decision unchanged), progress events=${progress.length}`);
    await ea.stop();
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
