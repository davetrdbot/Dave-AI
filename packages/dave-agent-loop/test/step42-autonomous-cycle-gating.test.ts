import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { EaTradeExecutor } from "@dave/ea-bridge";
import { recordError, resetCircuitBreaker } from "@dave/safety";
import { startTelegramBotServer, runAutonomousTradingCycle } from "../src/telegram-bot-server.js";
import { createAskUserTool, clearPendingQuestion } from "../src/ask-user.js";

/**
 * Real proof for item 2/6's real gating gap (user's reference pattern: "real gating checks
 * before any analysis: ... pending user question ... EA heartbeat freshness ... "). Root cause
 * confirmed: runAutonomousTradingCycle only ever checked isTradingHalted/getBusyState -- a
 * pending unanswered ask_user question, a disconnected EA, and a tripped circuit breaker were
 * all genuinely ignored, letting a cycle barrel ahead and waste a real provider call (or worse,
 * pile a second question on an unanswered one). This proves each real gate short-circuits the
 * cycle BEFORE any provider/model call happens -- confirmed by zero non-Telegram fetch calls.
 */

console.log("=== Real proof: the autonomous cycle's real gates short-circuit before any model call ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-cycle-gating-"));
process.chdir(workDir);
const OWNER = "user-cycle-gating-1";
const CHAT_ID = 552211;

let providerCallCount = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const urlStr = String(url);
  if (urlStr.includes("api.telegram.org")) {
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }
  // Any other fetch would be a real provider/model call -- the exact thing each gate must prevent.
  providerCallCount++;
  return realFetch(url as never, init).catch(() => new Response(JSON.stringify({ error: "unreachable" }), { status: 500 }));
}) as typeof fetch;

let server: Awaited<ReturnType<typeof startTelegramBotServer>> | undefined;
try {
  const db = new DaveDatabase(join(workDir, "dave.db"));
  const executor = new EaTradeExecutor(OWNER);
  const deps = { ownerUserId: OWNER, db, executor, botToken: "000000:fake-bot-token", publicBaseUrl: "https://dave.example.com", systemPrompt: "You are Dave." };
  server = await startTelegramBotServer(deps);

  console.log("[1] A real pending, unanswered ask_user question -- the cycle must genuinely skip, not pile a second question on top...\n");
  await createAskUserTool(OWNER).execute({ question: "Which account should I use?" });
  providerCallCount = 0;
  await runAutonomousTradingCycle(deps, server.client, CHAT_ID);
  assert.equal(providerCallCount, 0, "a real pending question must genuinely block the cycle before any model call");
  console.log(`    confirmed: 0 real model calls while a question is genuinely pending`);
  clearPendingQuestion(OWNER);

  console.log("\n[2] The EA has never reported (genuinely disconnected) -- the cycle must skip, not analyze nothing...\n");
  providerCallCount = 0;
  await runAutonomousTradingCycle(deps, server.client, CHAT_ID);
  assert.equal(providerCallCount, 0, "a real disconnected EA must genuinely block the cycle before any model call");
  console.log(`    confirmed: 0 real model calls while the EA has never reported`);

  console.log("\n[3] A genuinely tripped circuit breaker must block the cycle...\n");
  // Real EA connection first, so we isolate this test to the circuit-breaker gate specifically.
  const { createEaWebhookServer, getOrCreateEaWebhook } = await import("@dave/ea-bridge");
  const webhook = getOrCreateEaWebhook(OWNER);
  const eaServer = createEaWebhookServer();
  await new Promise<void>((resolve) => eaServer.listen(0, "127.0.0.1", resolve));
  const eaPort = (eaServer.address() as { port: number }).port;
  const { request } = await import("node:http");
  await new Promise<void>((resolve, reject) => {
    const body = JSON.stringify({ type: "heartbeat", account: "123", balance: 1000, positions: [], pendingOrders: [] });
    const req = request(
      { hostname: "127.0.0.1", port: eaPort, path: webhook.path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (res) => { res.on("data", () => {}); res.on("end", () => resolve()); }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
  eaServer.close();

  recordError(db, OWNER, "sim failure 1");
  recordError(db, OWNER, "sim failure 2");
  recordError(db, OWNER, "sim failure 3");
  providerCallCount = 0;
  await runAutonomousTradingCycle(deps, server.client, CHAT_ID);
  assert.equal(providerCallCount, 0, "a real tripped circuit breaker must genuinely block the cycle before any model call");
  console.log(`    confirmed: 0 real model calls while the circuit breaker is genuinely tripped`);
  resetCircuitBreaker(db, OWNER);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  globalThis.fetch = realFetch;
  if (server) server.server.close();
  rmSync(workDir, { recursive: true, force: true });
}

// startTelegramBotServer wires real node-cron jobs that keep the event loop alive -- same
// real-cleanup pattern other tests using it already use.
process.exit(0);
