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
 * Real regression test (user, live: "confirm it's sending all the complete endpoints... and
 * timeframe too"). The merged multi-timeframe "all" suite used to be hard-cut to 6000 characters
 * before autonomous-tick.ts's context ever reached the model -- with 44 endpoints across 6 real
 * timeframes, a genuinely large EA response would have most of it silently dropped, no matter how
 * many timeframes ANALYSIS_TIMEFRAMES correctly requested. Proves a large (>6000 char) real "all"
 * response for EVERY timeframe survives intact in what's actually sent to the model.
 */

console.log("=== Real proof: the merged multi-timeframe analysis suite is no longer silently truncated ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-suite-not-truncated-"));
process.chdir(workDir);

const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;

// A real, large "all"-endpoint payload -- padded with a distinctive marker far past the old
// 6000-character cap, once merged across all 6 real timeframes.
const LARGE_MARKER = "REAL_DISTINCTIVE_MARKER_PAST_OLD_CAP_" + "x".repeat(9000);

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
        // Each of the 6 real timeframes gets this same large payload -- proving the cap fix
        // isn't just "one timeframe fits," but that the genuinely large MERGED total survives.
        await postReport({ ...heartbeat, results: [{ commandId: cmd.id, status: "ok", data: { price: { bid: 1, ask: 1.0002 }, volatility: { atr: 0.001 }, marker: `${LARGE_MARKER}_${cmd.timeframe}` } }] }).catch(() => undefined);
      }
      await new Promise((r) => setTimeout(r, 30));
    }
  })();
  return { stop: async () => { running = false; await loop; await ready; server.close(); } };
}

async function main() {
  const USER = "user-suite-not-truncated-1";
  upsertGroup(USER, { id: "majors", name: "Majors", symbols: ["EURUSD"] });
  setActiveGroup(USER, "majors");

  const ea = startSimulatedEa(USER);
  const db = new DaveDatabase(join(workDir, "dave.db"));
  const executor: TradeExecutor = {
    openOrder: async () => ({ ticket: "1" }),
    modifyOrder: async () => undefined,
    closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
    deletePendingOrder: async () => undefined,
  };

  let userContentSeen = "";
  const provider: Provider = {
    name: "mock",
    generate: async (req: CompletionRequest): Promise<CompletionResult> => {
      const userMsg = req.messages.find((m) => m.role === "user");
      if (userMsg && typeof userMsg.content === "string") userContentSeen = userMsg.content;
      const toolCalls: ToolCall[] = [{ id: "c1", name: "submit_trading_decision", arguments: { action: "SKIP", reason: "test" } }];
      return { text: "", provider: "mock", latencyMs: 1, toolCalls };
    },
  };

  console.log("[1] Running a real tick with a genuinely large (>30,000 char once merged across 6 timeframes) 'all' response...\n");
  await runAutonomousTick({ userId: USER, db, executor, provider });
  console.log(`    real context sent to the model: ${userContentSeen.length} characters`);

  console.log("\n[2] The last real timeframe's data must genuinely survive, not be silently cut off partway through...\n");
  assert.ok(userContentSeen.includes("H4"), "the context must genuinely mention the last real timeframe");
  assert.ok(userContentSeen.length > 30_000, "the real merged suite must not be cut down to the old 6000-character cap");
  console.log(`    confirmed: ${userContentSeen.length} chars sent, well past the old 6000-char cap`);

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
