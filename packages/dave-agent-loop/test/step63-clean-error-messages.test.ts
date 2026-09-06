import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { DaveDatabase } from "@dave/db";
import { DavemaClient } from "@dave/davema";
import { EaTradeExecutor } from "@dave/ea-bridge";
import { RFeedBridge } from "@dave/rfeed";
import { addProviderKey, setModelConfig } from "@dave/brain";
import { startTelegramBotServer } from "../src/telegram-bot-server.js";
import { friendlyErrorMessage } from "../src/error-messages.js";

/**
 * Real proof for item 3: "when all keys for a provider are exhausted, the user sees the raw
 * internal error 'Something went wrong handling that: no stored keys for provider claude'. This
 * must never reach the user directly." Confirms both the unit-level mapping AND the real
 * end-to-end webhook path: a real user message whose configured provider genuinely has zero
 * stored keys gets a clean, honest message, never the raw internal error string.
 */

console.log("=== Real proof: raw internal errors never reach the user ===\n");

console.log("[1] friendlyErrorMessage() maps the real reported bug's exact error text to a clean message...");
const raw = new Error(`no stored keys for provider "claude"`);
const clean = friendlyErrorMessage(raw);
console.log(`    raw:   "${raw.message}"`);
console.log(`    clean: "${clean}"`);
assert.ok(!clean.includes("no stored keys for provider"), "the raw internal phrase must never survive into the clean message");
assert.match(clean, /claude/i);
assert.match(clean, /has no working keys/i);

console.log("\n[2] An unrecognized/unexpected error still gets a clean generic message, never its raw internals...");
const weird = new Error("TypeError: Cannot read properties of undefined (reading 'foo') at /app/src/internal-module.ts:42:7");
const cleanWeird = friendlyErrorMessage(weird);
console.log(`    clean: "${cleanWeird}"`);
assert.ok(!cleanWeird.includes("internal-module.ts"), "no stack-trace-shaped internals may leak");
assert.ok(!cleanWeird.includes("TypeError"));

const workDir = mkdtempSync(join(tmpdir(), "dave-clean-errors-"));
process.chdir(workDir);
const OWNER = "user-clean-errors-1";
const CHAT_ID = 222999;

const sentMessages: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const urlStr = String(url);
  if (urlStr.includes("api.telegram.org")) {
    const method = urlStr.split("/").pop() ?? "";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (body?.text) sentMessages.push(body.text);
    if (method === "setWebhook" || method === "setMyCommands" || method === "setMyDescription" || method === "setMyShortDescription" || method === "answerCallbackQuery") {
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }
  return new Response("should never be called -- no provider key exists", { status: 500 });
}) as typeof fetch;

let server: Awaited<ReturnType<typeof startTelegramBotServer>> | undefined;
try {
  const db = new DaveDatabase(join(workDir, "dave.db"));
  // Deliberately configure "claude" as primary with NO stored key at all -- the exact real
  // production bug: generateWithKeyFailover throws `no stored keys for provider "claude"`.
  setModelConfig(OWNER, { primary: "claude", fallback: [] });

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

  console.log("\n[3] End-to-end: a real message against a provider with ZERO stored keys gets a clean message, never the raw internal error...");
  await postUpdate({ update_id: 1, message: { message_id: 1, chat: { id: CHAT_ID }, text: "find me a setup", date: Date.now() / 1000 } });
  await new Promise((r) => setTimeout(r, 150));

  console.log(`    real messages sent to Telegram: ${JSON.stringify(sentMessages)}`);
  const combined = sentMessages.join("\n");
  assert.ok(!combined.includes("no stored keys for provider"), "the raw internal error text must NEVER reach the user");
  assert.ok(!combined.includes("Something went wrong handling that:"), "the old raw-error-leaking prefix must be gone");
  assert.match(combined, /claude/i, "the clean message should still honestly name the provider");
  assert.match(combined, /working keys|add one|providers/i, "the clean message must be actionable");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  server?.server.close();
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
