import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { DaveDatabase } from "@dave/db";
import { EaTradeExecutor } from "@dave/ea-bridge";
import { addProviderKey } from "@dave/brain";
import { startTelegramBotServer } from "../src/telegram-bot-server.js";
import { getBusyState } from "../src/busy-state.js";
import { getPendingDelegationQueue } from "../src/delegation.js";

/**
 * Real proof for the confirmed bug (independent audit): `/stop`/`/panic` genuinely aborted an
 * in-flight turn via abortTurn(), but never touched the pending-delegation queue -- a message
 * that arrived while busy (and got the real 3-button "pause/worker/skip" prompt) was left
 * silently sitting in pending-delegation.json forever, with a now-stale prompt.
 *
 * This drives the REAL flow: a first message creates a genuine in-flight turn (model call held
 * open, not simulated), a second real message arrives while busy and gets genuinely queued via
 * addPendingDelegation (proven via the real 3-button prompt, same as step49), then a real /stop
 * is sent while the first turn is still in flight. Proves:
 *   (a) the queued pending-delegation entry is genuinely cleared once /stop aborts something
 *   (b) the real /stop confirmation message genuinely mentions the discarded count
 *   (c) a SEPARATE /stop with nothing queued does NOT falsely claim anything was discarded
 */

console.log("=== Real proof: /stop discards (and announces) any pending delegation queue ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-stop-delegation-"));
process.chdir(workDir);
const OWNER = "user-stop-delegation-1";
const CHAT_ID = 777111;

const sentMessages: Array<{ text: string }> = [];
let releaseFirstCall: (() => void) | undefined;
let firstCallStarted = new Promise<void>((resolve) => {
  (globalThis as unknown as { __resolveFirstCallStarted?: () => void }).__resolveFirstCallStarted = resolve;
});

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const urlStr = String(url);
  if (urlStr.includes("api.telegram.org")) {
    const method = urlStr.split("/").pop() ?? "";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (body?.text) sentMessages.push({ text: body.text });
    if (method === "setWebhook" || method === "setMyCommands" || method === "setMyDescription" || method === "setMyShortDescription") {
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }
  // The real provider HTTP call -- deliberately held open for the FIRST call only, to create a
  // genuine, real in-flight overlap (not a fake sleep).
  if (!releaseFirstCall) {
    (globalThis as unknown as { __resolveFirstCallStarted: () => void }).__resolveFirstCallStarted();
    await new Promise<void>((resolve) => { releaseFirstCall = resolve; });
  }
  return new Response(JSON.stringify({ choices: [{ message: { content: "Real reply after being unblocked." } }] }), { status: 200 });
}) as typeof fetch;

let server: Awaited<ReturnType<typeof startTelegramBotServer>> | undefined;
try {
  const db = new DaveDatabase(join(workDir, "dave.db"));
  addProviderKey(db, OWNER, "openai", "test key", { apiKey: "sk-real-fake" });
  const { setModelConfig } = await import("@dave/brain");
  setModelConfig(OWNER, { primary: "openai", fallback: [] });

  const executor = new EaTradeExecutor(OWNER);

  server = await startTelegramBotServer({
    ownerUserId: OWNER,
    db,
    executor,
    botToken: "000000:fake-bot-token",
    publicBaseUrl: "https://dave.example.com",
    systemPrompt: "You are Dave.",
  });
  await new Promise<void>((resolve) => server!.server.listen(0, "127.0.0.1", resolve));
  const port = (server.server.address() as { port: number }).port;
  const webhookPath = new URL(server.webhookUrl).pathname;
  const routeInfo = (await import("@dave/telegram")).getOrCreateTelegramWebhookRoute(OWNER);

  const postUpdate = (body: unknown) =>
    new Promise<void>((resolve, reject) => {
      const json = JSON.stringify(body);
      const req = request(
        { hostname: "127.0.0.1", port, path: webhookPath, method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": routeInfo.secretToken, "content-length": Buffer.byteLength(json) } },
        (res) => { res.resume(); res.on("end", resolve); }
      );
      req.on("error", reject);
      req.write(json);
      req.end();
    });

  console.log("[1] First message starts a real, genuinely in-flight agent turn (model call deliberately held open)...");
  const firstPost = postUpdate({ update_id: 1, message: { message_id: 1, chat: { id: CHAT_ID }, text: "find me a setup on gold", date: Date.now() / 1000 } });
  await firstCallStarted;
  assert.ok(getBusyState(OWNER), "busy state must be genuinely set while the first turn is in flight");

  console.log("[2] A second real message arrives WHILE busy -- gets genuinely queued via addPendingDelegation (real 3-button prompt)...");
  sentMessages.length = 0;
  await postUpdate({ update_id: 2, message: { message_id: 2, chat: { id: CHAT_ID }, text: "also check EURUSD", date: Date.now() / 1000 } });
  assert.equal(getPendingDelegationQueue(OWNER).length, 1, "the second message must be genuinely queued while busy");

  console.log("\n[3] /stop arrives while the first turn is STILL in flight -- must abort the turn AND clear+announce the queue...");
  sentMessages.length = 0;
  await postUpdate({ update_id: 3, message: { message_id: 3, chat: { id: CHAT_ID }, text: "/stop", date: Date.now() / 1000 } });
  const stopReply = sentMessages.find((m) => m.text.includes("Stopped"));
  assert.ok(stopReply, "a real /stop confirmation message must have been sent");
  console.log(`    real /stop reply: "${stopReply!.text}"`);
  assert.ok(stopReply!.text.includes("cancelled the message you were waiting on"), "must confirm the in-flight turn was genuinely cancelled");
  assert.match(stopReply!.text, /discarded 1 message/i, "(b) must genuinely mention the discarded count");
  assert.equal(getPendingDelegationQueue(OWNER).length, 0, "(a) the pending-delegation queue must be genuinely cleared, not left stale/orphaned");

  console.log("\n[4] Release the (now-aborted) first call so the process can exit cleanly, then wait for busy state to clear...");
  releaseFirstCall?.();
  await firstPost;
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(getBusyState(OWNER), null);

  console.log("\n[5] A SECOND, separate /stop with nothing in flight and nothing queued must NOT falsely claim anything was discarded...");
  sentMessages.length = 0;
  assert.equal(getPendingDelegationQueue(OWNER).length, 0, "sanity: nothing queued going in");
  await postUpdate({ update_id: 4, message: { message_id: 4, chat: { id: CHAT_ID }, text: "/stop", date: Date.now() / 1000 } });
  const secondStopReply = sentMessages.find((m) => m.text.includes("Stopped"));
  assert.ok(secondStopReply, "a second real /stop confirmation message must have been sent");
  console.log(`    real /stop reply: "${secondStopReply!.text}"`);
  assert.ok(!/discarded/i.test(secondStopReply!.text), "(c) must NOT claim anything was discarded when nothing was queued");
  assert.ok(!secondStopReply!.text.includes("cancelled the message you were waiting on"), "nothing was genuinely in flight to cancel this time");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  server?.server.close();
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
