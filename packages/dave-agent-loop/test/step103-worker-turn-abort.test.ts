import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { DaveDatabase } from "@dave/db";
import { EaTradeExecutor } from "@dave/ea-bridge";
import { addProviderKey, setModelConfig } from "@dave/brain";
import { TelegramClient } from "@dave/telegram";
import { createWorker } from "@dave/workers";
import { buildFullToolRegistry } from "../src/full-registry.js";
import { runWorkerTask } from "../src/worker-loop.js";
import { beginTurn, endTurn, abortTurn } from "../src/turn-abort.js";

/**
 * Real gap closed (independent audit): worker-loop.ts's `runWorkerTask` built its own AgentLoop
 * and called `.run()` for a delegated worker task WITHOUT ever calling beginTurn/endTurn or
 * passing a signal -- so a genuinely stuck worker task was completely unreachable by /stop or
 * /panic; the only thing that would ever end it was AgentLoop's own baked-in overall deadline
 * (~4 minutes). This proves the real fix: a worker whose underlying provider call hangs can
 * genuinely be cancelled early via abortTurn(ownerUserId) -- well before that default deadline
 * would ever fire -- and runWorkerTask resolves promptly, reporting the cancellation.
 */

console.log("=== Real proof: a stuck WORKER task can genuinely be cancelled early via /stop's abortTurn ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-worker-turn-abort-"));
process.chdir(workDir);
const OWNER = "user-worker-turn-abort-1";
const CHAT_ID = 424242;
const PUBLIC_BASE_URL = "https://dave.example.com";

// Deliberately never responds -- simulates a genuinely hung upstream provider call, same as
// step102-turn-abort.test.ts's real stuck/hanging servers.
let requestWasAborted = false;
const hangingServer = createServer((req, _res) => {
  req.on("aborted", () => {
    requestWasAborted = true;
  });
});

const realFetch = globalThis.fetch;

async function main() {
  await new Promise<void>((resolve) => hangingServer.listen(0, resolve));
  const port = (hangingServer.address() as any).port;

  // Telegram + worker-webhook calls still need to be answered so the rest of runWorkerTask's
  // real plumbing (report-to-user's live client.sendMessage, retireWorker, etc.) behaves
  // normally; only the actual model provider call is left genuinely hanging.
  const telegramMessages: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.includes("api.telegram.org")) {
      const method = urlStr.split("/").pop() ?? "";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      if (method === "setWebhook" || method === "setMyCommands" || method === "setMyDescription" || method === "setMyShortDescription") {
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      }
      if (body?.text) telegramMessages.push(body.text);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (urlStr.startsWith(`${PUBLIC_BASE_URL}/hooks/worker/`)) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    // Everything else (the real provider call) goes through the real network to our real
    // hanging node:http server below -- genuinely never responds until aborted.
    return realFetch(url as any, init);
  }) as typeof fetch;

  const db = new DaveDatabase(join(workDir, "dave.db"));
  // baseUrlOverride points the real openai-compatible provider at our real hanging local
  // server instead of the real api.openai.com -- exactly the mechanism custom/self-hosted
  // provider endpoints already use in production (provider-factory.ts).
  addProviderKey(db, OWNER, "openai", "worker key", {
    apiKey: "sk-openai-fake",
    model: "gpt-worker-model",
    baseUrlOverride: `http://127.0.0.1:${port}`,
  });
  setModelConfig(OWNER, { primary: "openai", fallback: [] });

  const executor = new EaTradeExecutor(OWNER);
  const client = new TelegramClient("000000:fake-token-for-transport-mock");
  const fullRegistry = buildFullToolRegistry({
    userId: OWNER,
    db,
    executor,
    telegram: { client, chatId: CHAT_ID },
    publicBaseUrl: PUBLIC_BASE_URL,
  });

  const worker = createWorker(OWNER, { assignment: "temporary", role: "generic", task: "Investigate a genuinely stuck task." });

  console.log("[1] Kick off a real worker task whose underlying provider call genuinely hangs...");
  const started = Date.now();
  const runPromise = runWorkerTask({
    db,
    ownerUserId: OWNER,
    executor,
    publicBaseUrl: PUBLIC_BASE_URL,
    client,
    chatId: CHAT_ID,
    worker,
    task: worker.task,
    fullRegistry,
  });

  // Give the real HTTP request time to actually reach the hanging server before cancelling.
  await new Promise((r) => setTimeout(r, 300));

  console.log("\n[2] /stop's real abortTurn(ownerUserId) genuinely reaches the worker's in-flight turn...");
  const wasCancelled = abortTurn(OWNER);
  assert.equal(wasCancelled, true, "abortTurn must report it genuinely found and cancelled the worker's real in-flight turn -- proving runWorkerTask actually registered it with turn-abort.ts");

  await runPromise;
  const elapsed = Date.now() - started;
  console.log(`    runWorkerTask resolved after ${elapsed}ms (AgentLoop's own default overall deadline is ~240000ms)`);
  assert.ok(elapsed < 5_000, `must resolve promptly from the real early cancel, nowhere near the ~4 minute default deadline (took ${elapsed}ms)`);

  console.log("\n[3] The worker's own run genuinely observed the cancel and reported it, rather than crashing on an unhandled 'aborted' status...");
  const stoppedMsg = telegramMessages.find((t) => t.toLowerCase().includes("stopped") || t.toLowerCase().includes("cancel"));
  assert.ok(stoppedMsg, `runWorkerTask must report the real cancellation back through its normal completion path, got messages: ${JSON.stringify(telegramMessages)}`);
  console.log(`    real reported message: "${stoppedMsg}"`);

  await new Promise((r) => setTimeout(r, 200));
  assert.equal(requestWasAborted, true, "the real underlying HTTP request to the provider must genuinely be aborted, not just abandoned by the caller");
  console.log(`    real underlying provider request genuinely aborted=${requestWasAborted}`);

  console.log("\n[4] A second turn for the same user is NOT still blocked by the just-ended worker turn (endTurn genuinely ran)...");
  const controller2 = beginTurn(OWNER);
  const stillTracked = abortTurn(OWNER);
  assert.equal(stillTracked, true, "beginTurn for a fresh turn must genuinely register (proves endTurn cleared the worker's controller, not leaking it)");
  endTurn(OWNER, controller2);
  console.log("    confirmed: endTurn genuinely ran in the worker's finally block, no leaked controller");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    globalThis.fetch = realFetch;
    await new Promise<void>((resolve) => hangingServer.close(() => resolve()));
    rmSync(workDir, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  });
