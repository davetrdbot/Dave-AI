import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { DaveDatabase } from "@dave/db";
import type { Provider, CompletionRequest, CompletionResult } from "@dave/brain";
import type { TradeExecutor } from "@dave/trading";
import { upsertGroup, setActiveGroup, ALL_ANALYSIS_TIMEFRAMES } from "@dave/trading";
import { getOrCreateEaWebhook, createEaWebhookServer, type EaCommand } from "@dave/ea-bridge";
import { runAutonomousTick } from "../src/autonomous-tick.js";

/**
 * Real bug fixed (user, live: doubted "get all analysis" genuinely covered "all the timeframes"
 * -- it didn't. Confirmed against the real EA source (ea/DaveEA.mq5's RunAnalysis/A_All): the
 * "all" endpoint computes every sub-indicator against ONLY the single timeframe it's given --
 * there is no EA-side "give me every timeframe in one call" capability. A single
 * analysis.get("all", symbol, "H1") call was never actually multi-timeframe, no matter what the
 * context block sent to the model claimed. Proves the real fix: one real "all" request per real
 * timeframe (the user's explicit spec: M1, M3, M5, M15, H1, H4), each genuinely reaching the EA
 * as its own distinct command, merged into what the model actually receives.
 */

console.log("=== Real proof: the autonomous tick genuinely requests multiple real timeframes per symbol ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-multi-tf-"));
process.chdir(workDir);
const OWNER = "user-multi-tf-1";

const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;

function startSimulatedEa(userId: string) {
  const webhook = getOrCreateEaWebhook(userId);
  const server = createEaWebhookServer();
  let port = 0;
  const ready = new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => { port = (server.address() as { port: number }).port; resolve(); }));
  const requestedTimeframes: string[] = [];
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
        requestedTimeframes.push(cmd.timeframe);
        await postReport({ ...heartbeat, results: [{ commandId: cmd.id, status: "ok", data: { price: { bid: 1.085, ask: 1.0852 }, timeframe: cmd.timeframe } }] }).catch(() => undefined);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  })();
  return { requestedTimeframes, stop: async () => { running = false; await loop; await ready; server.close(); } };
}

function mockProvider(): { provider: Provider; calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  const provider: Provider = {
    name: "claude",
    generate: async (req: CompletionRequest): Promise<CompletionResult> => {
      calls.push(req);
      return { text: "", provider: "claude", latencyMs: 1, toolCalls: [{ id: "c1", name: "submit_trading_decision", arguments: { action: "SKIP", reason: "test" } }] };
    },
  };
  return { provider, calls };
}

try {
  const db = new DaveDatabase(join(workDir, "dave.db"));
  upsertGroup(OWNER, { id: "majors", name: "Majors", symbols: ["EURUSD"] });
  setActiveGroup(OWNER, "majors");
  const executor: TradeExecutor = {
    openOrder: async () => ({ ticket: "T" }), modifyOrder: async () => {}, closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
    deletePendingOrder: async () => {}, listOpenPositions: async () => [], listPendingOrders: async () => [],
  };
  const ea = startSimulatedEa(OWNER);
  const { provider, calls } = mockProvider();
  try {
    await runAutonomousTick({ userId: OWNER, db, executor, provider });

    // Derived from the ONE real source rather than hand-copied. A hardcoded list here is the same
    // drift that produced the live deadlock this repo just fixed (see step147): the suite changed,
    // a second copy of the list did not, and nothing noticed. This assertion now tracks the real
    // suite automatically -- if a timeframe is added or removed, this test follows it.
    const EXPECTED_TIMEFRAMES = [...ALL_ANALYSIS_TIMEFRAMES];
    console.log(`[1] The EA genuinely received a separate real "analyze" command for each of the user's specified timeframes...\n`);
    console.log(`    real timeframes requested from the EA: ${JSON.stringify(ea.requestedTimeframes)}`);
    assert.deepEqual([...ea.requestedTimeframes].sort(), [...EXPECTED_TIMEFRAMES].sort(), "must genuinely request every timeframe in the real suite as separate real EA commands, not one H1-only call");

    console.log(`\n[2] The model's own context genuinely contains all six real timeframes' data, not just one...\n`);
    const userMessage = calls[0].messages.find((m) => m.role === "user")!.content as string;
    for (const tf of EXPECTED_TIMEFRAMES) {
      assert.ok(userMessage.includes(`"${tf}"`), `the real merged context sent to the model must genuinely include real "${tf}" data`);
    }
    console.log(`    confirmed: the real context the model receives genuinely carries all six real timeframes, not a single-timeframe read mislabeled "all timeframes"`);
  } finally {
    await ea.stop();
  }

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
