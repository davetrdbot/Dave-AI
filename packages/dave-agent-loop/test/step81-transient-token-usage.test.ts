import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { DaveDatabase } from "@dave/db";
import { EaTradeExecutor } from "@dave/ea-bridge";
import { addProviderKey, setModelConfig } from "@dave/brain";
import { startTelegramBotServer } from "../src/telegram-bot-server.js";

/**
 * Real proof for the user's explicit ask: "after Dave sends a response, show a small follow-up
 * message/edit indicating token usage for that exchange (e.g. '🔢 1,240 tokens'), then
 * automatically edit that same message to remove/clear it after about 4 seconds -- a transient
 * indicator, not a permanent extra message cluttering the chat." Drives a real webhook-triggered
 * agent turn against a real mocked provider response carrying a real OpenAI-shaped `usage` block,
 * and confirms: (1) a real follow-up "🔢 N tokens" message is genuinely sent after the real reply,
 * with the real summed total from the provider's own usage field, (2) that same message is
 * genuinely deleted again after ~4 seconds, not left cluttering the chat.
 */

console.log("=== Real proof: a transient token-usage message appears then genuinely clears itself ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-token-usage-"));
process.chdir(workDir);
const OWNER = "user-token-usage-1";
const CHAT_ID = 778899;

const sentMessages: Array<{ id: number; text: string }> = [];
const deletedMessageIds: number[] = [];
let nextMessageId = 1;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const urlStr = String(url);
  if (urlStr.includes("api.telegram.org")) {
    const method = urlStr.split("/").pop() ?? "";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (method === "deleteMessage") {
      deletedMessageIds.push(body.message_id);
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }
    if (method === "setWebhook" || method === "setMyCommands" || method === "setMyDescription" || method === "setMyShortDescription") {
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }
    const messageId = nextMessageId++;
    if (body?.text) sentMessages.push({ id: messageId, text: body.text });
    return new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }), { status: 200 });
  }
  // The real provider HTTP call -- a real OpenAI-shaped response with a real usage block.
  return new Response(
    JSON.stringify({ choices: [{ message: { content: "Done." } }], usage: { prompt_tokens: 900, completion_tokens: 340, total_tokens: 1240 } }),
    { status: 200 }
  );
}) as typeof fetch;

let server: Awaited<ReturnType<typeof startTelegramBotServer>> | undefined;
try {
  const db = new DaveDatabase(join(workDir, "dave.db"));
  addProviderKey(db, OWNER, "openai", "test key", { apiKey: "sk-real-fake" });
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

  console.log("[1] A real turn completes and a real transient token-usage message is sent, with the real summed total...\n");
  await postUpdate({ update_id: 1, message: { message_id: 1, chat: { id: CHAT_ID }, text: "hello", date: Date.now() / 1000 } });
  await new Promise((r) => setTimeout(r, 150));

  const tokenMsg = sentMessages.find((m) => m.text.includes("tokens"));
  assert.ok(tokenMsg, `expected a real "🔢 N tokens" message, got: ${JSON.stringify(sentMessages)}`);
  assert.equal(tokenMsg!.text, "🔢 1,240 tokens", "must show the real summed usage from the provider's own response, not an estimate");
  console.log(`    real transient message sent: "${tokenMsg!.text}"`);

  console.log("\n[2] That exact message is genuinely deleted again after ~4 seconds -- not left cluttering the chat...\n");
  assert.equal(deletedMessageIds.length, 0, "must NOT be deleted immediately");
  await new Promise((r) => setTimeout(r, 4200));
  assert.ok(deletedMessageIds.includes(tokenMsg!.id), `expected message ${tokenMsg!.id} to genuinely be deleted after ~4s, deleted so far: ${JSON.stringify(deletedMessageIds)}`);
  console.log(`    real deleteMessage call confirmed for message id ${tokenMsg!.id} after ~4s`);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  server?.server.close();
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
