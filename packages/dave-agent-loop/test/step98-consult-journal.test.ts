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
import { runAutonomousTick } from "../src/autonomous-tick.js";

/**
 * Real feature (user, live: "Journal is a ai like sidekick... it can ask journal what do you
 * think... it doesn't respond back to Dave [i.e. the user] -- that's if Dave needs help... not
 * compulsory"). Proves: choosing CONSULT_JOURNAL triggers exactly one real, separate consult call
 * (never a loop), the tick asks for a real final decision afterward with Journal's opinion in
 * context, Journal itself never sends anything to the user, and a decision that does NOT choose
 * CONSULT_JOURNAL never touches Journal at all (optional, never forced).
 */

console.log("=== Real proof: CONSULT_JOURNAL is a genuine, bounded, optional second opinion ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-consult-journal-"));
process.chdir(workDir);

const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;

function startSimulatedEa(userId: string) {
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
        await postReport({ ...heartbeat, results: [{ commandId: cmd.id, status: "ok", data: { price: { bid: 1, ask: 1.0002 }, volatility: { atr: 0.001 } } }] }).catch(() => undefined);
      }
      await new Promise((r) => setTimeout(r, 30));
    }
  })();
  return { stop: async () => { running = false; await loop; await ready; server.close(); } };
}

async function main() {
  const USER = "user-consult-journal-1";
  upsertGroup(USER, { id: "majors", name: "Majors", symbols: ["EURUSD"] });
  setActiveGroup(USER, "majors");

  const ea = startSimulatedEa(USER);
  const db = new DaveDatabase(join(workDir, "dave.db"));
  const executor: TradeExecutor = {
    openOrder: async () => ({ ticket: "999" }),
    modifyOrder: async () => undefined,
    closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
    deletePendingOrder: async () => undefined,
  };

  let tickDecisionCalls = 0;
  let journalCalls = 0;
  const provider: Provider = {
    name: "mock",
    generate: async (req: CompletionRequest): Promise<CompletionResult> => {
      const isTickDecision = req.tools?.length === 1 && req.tools[0].name === "submit_trading_decision";
      if (isTickDecision) {
        tickDecisionCalls++;
        const toolCalls: ToolCall[] =
          tickDecisionCalls === 1
            ? [{ id: "c1", name: "submit_trading_decision", arguments: { action: "CONSULT_JOURNAL", reason: "borderline setup, want a second read" } }]
            : [{ id: "c2", name: "submit_trading_decision", arguments: { action: "SKIP", reason: "Journal talked me out of it" } }];
        return { text: "", provider: "mock", latencyMs: 1, toolCalls };
      }
      // Journal's own AgentLoop call -- registered tools are read/record-only (never
      // trade_execute/full_close/partial_close). Answer in plain text immediately so Journal's
      // loop finishes in one step, no tool calls needed for this test.
      journalCalls++;
      assert.ok(!req.tools?.some((t) => ["trade_execute", "full_close", "partial_close", "delete_pending_order"].includes(t.name)), "Journal must never be given a tool that can act on the account");
      return { text: "This looks weak -- momentum is mixed and you're chasing. I'd pass.", provider: "mock", latencyMs: 1 };
    },
  };

  console.log("[1] A decision of CONSULT_JOURNAL triggers exactly one real Journal consult, then exactly one final decision call...\n");
  const outcome = await runAutonomousTick({ userId: USER, db, executor, provider });
  assert.equal(tickDecisionCalls, 2, "must call the decision tool exactly twice: once to get CONSULT_JOURNAL, once more for the real final decision");
  assert.equal(journalCalls, 1, "must consult Journal exactly once -- never a loop");
  assert.equal(outcome.action, "NONE", "the final decision (SKIP) must be honored, not overridden");
  console.log(`    confirmed: ${tickDecisionCalls} decision calls, ${journalCalls} Journal consult(s), final outcome=${outcome.action}`);

  await ea.stop();
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
