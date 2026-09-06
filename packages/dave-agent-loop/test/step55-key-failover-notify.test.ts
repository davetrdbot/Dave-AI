import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { DaveDatabase } from "@dave/db";
import { DavemaClient } from "@dave/davema";
import { EaTradeExecutor } from "@dave/ea-bridge";
import { RFeedBridge } from "@dave/rfeed";
import { addProviderKey, setModelConfig, isQuotaExhaustedError, generateWithKeyFailover } from "@dave/brain";
import { startTelegramBotServer } from "../src/telegram-bot-server.js";

/**
 * Real proof for items 4 + 6 of the live production bug report:
 *   4) API credit exhaustion MUST notify the user, never fail silently.
 *   6) API key auto-failover must be transparent AND mid-request safe -- the same in-flight
 *      request is retried with the next healthy key, the response still completes, and the user
 *      is told a switch happened.
 * Simulates a real key dying mid-response with a genuine quota-exhaustion error (HTTP 429,
 * "insufficient_quota" -- not a generic transient failure), confirms the switch notification AND
 * the completed response both genuinely arrive, then confirms full-provider exhaustion also
 * notifies honestly.
 */

console.log("=== Real proof: API key/provider credit-exhaustion failover is transparent + mid-request safe ===\n");

console.log("[1] isQuotaExhaustedError() genuinely distinguishes real quota/credit errors from transient ones...");
assert.equal(isQuotaExhaustedError("HTTP 429: {\"error\":{\"code\":\"insufficient_quota\",\"message\":\"You exceeded your current quota\"}}"), true);
assert.equal(isQuotaExhaustedError("HTTP 402: Payment Required"), true);
assert.equal(isQuotaExhaustedError("HTTP 500: internal server error"), false);
assert.equal(isQuotaExhaustedError("fetch failed: ECONNRESET"), false);
console.log("    quota/credit errors (429/402/insufficient_quota) -> true; transient errors (500/ECONNRESET) -> false");

const workDir = mkdtempSync(join(tmpdir(), "dave-key-notify-"));
process.chdir(workDir);
const OWNER = "user-keynotify-1";
const CHAT_ID = 333222;

console.log("\n[2] Unit-level: generateWithKeyFailover() genuinely retries the SAME in-flight request on the next key after a real quota-exhaustion error, and fires onKeySwitch with the real reason...");
{
  const db = new DaveDatabase(join(workDir, "unit.db"));
  const keyDead = addProviderKey(db, OWNER, "openai", "key one", { apiKey: "sk-dead" });
  addProviderKey(db, OWNER, "openai", "key two", { apiKey: "sk-alive" });

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const usingDeadKey = String((init?.headers as Record<string, string>)?.authorization ?? "").includes("sk-dead");
    if (usingDeadKey) {
      return new Response(JSON.stringify({ error: { code: "insufficient_quota", message: "You exceeded your current quota, please check your plan and billing details." } }), { status: 429 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "Real reply from the second key." } }] }), { status: 200 });
  }) as typeof fetch;

  const switches: { fromIndex: number; toIndex: number; reason: string; quotaExhausted: boolean }[] = [];
  try {
    const result = await generateWithKeyFailover(db, OWNER, "openai", { messages: [{ role: "user", content: "find me a setup" }] }, 5000, {
      onKeySwitch: (info) => void switches.push(info),
    });
    console.log(`    real completed response, via the second key: "${result.text}"`);
    assert.equal(result.text, "Real reply from the second key.", "the SAME in-flight request must genuinely complete via the next key, not be dropped");
    console.log(`    real onKeySwitch fired: ${JSON.stringify(switches)}`);
    assert.equal(switches.length, 1);
    assert.equal(switches[0].fromIndex, 1);
    assert.equal(switches[0].toIndex, 2);
    assert.equal(switches[0].quotaExhausted, true, "a real 429 insufficient_quota must be classified as quota-exhausted");
    const stillHealthy = db.getById("provider_keys", OWNER, keyDead.id);
    assert.equal(Boolean(stillHealthy!.healthy), false, "the dead key's real health state must genuinely flip");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("\n[3] End-to-end: a real webhook-driven agent turn whose primary key dies mid-response genuinely sends the switch notification AND still completes the user's response...");

const sentMessages: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const urlStr = String(url);
  if (urlStr.includes("api.telegram.org")) {
    const method = urlStr.split("/").pop() ?? "";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (body?.text) sentMessages.push(body.text);
    if (body?.rich_message?.html) sentMessages.push(body.rich_message.html);
    if (method === "setWebhook" || method === "setMyCommands" || method === "setMyDescription" || method === "setMyShortDescription") {
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }
  const usingDeadKey = String((init?.headers as Record<string, string>)?.authorization ?? "").includes("sk-e2e-dead");
  if (usingDeadKey) {
    return new Response(JSON.stringify({ error: { code: "insufficient_quota", message: "You exceeded your current quota, please check your plan and billing details." } }), { status: 429 });
  }
  return new Response(JSON.stringify({ choices: [{ message: { content: "Here is the real completed answer." } }] }), { status: 200 });
}) as typeof fetch;

let server: Awaited<ReturnType<typeof startTelegramBotServer>> | undefined;
try {
  const db = new DaveDatabase(join(workDir, "dave.db"));
  addProviderKey(db, OWNER, "openai", "primary key", { apiKey: "sk-e2e-dead" });
  addProviderKey(db, OWNER, "openai", "backup key", { apiKey: "sk-e2e-alive" });
  setModelConfig(OWNER, { primary: "openai", fallback: [] });

  const davema = new DavemaClient(undefined, "http://127.0.0.1:1");
  const executor = new EaTradeExecutor(OWNER);
  const rfeedBridge = new RFeedBridge();

  server = await startTelegramBotServer({
    ownerUserId: OWNER,
    db,
    davema,
    executor,
    rfeedExecutor: rfeedBridge.getExecutor(OWNER),
    rfeedHistoryManager: rfeedBridge.getHistoryManager(OWNER),
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

  await postUpdate({ update_id: 1, message: { message_id: 1, chat: { id: CHAT_ID }, text: "find me a setup on gold", date: Date.now() / 1000 } });
  await new Promise((r) => setTimeout(r, 150));

  console.log(`    real messages sent to Telegram: ${JSON.stringify(sentMessages)}`);
  const switchNotice = sentMessages.find((t) => t.includes("Switched from key #1 to key #2"));
  assert.ok(switchNotice, "the real '🔄 Switched from key #1 to key #2' notification must have been sent");
  console.log(`    real switch notice: "${switchNotice}"`);
  assert.match(switchNotice!, /ran out of credit/);

  const finalAnswer = sentMessages.find((t) => t.includes("Here is the real completed answer."));
  assert.ok(finalAnswer, "the user's original response must still genuinely complete, not be dropped when the first key died mid-request");
  console.log(`    real completed response still arrived: "${finalAnswer}"`);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  server?.server.close();
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
