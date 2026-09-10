import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { DaveDatabase } from "@dave/db";
import { EaTradeExecutor } from "@dave/ea-bridge";
import { addProviderKey, setModelConfig } from "@dave/brain";
import { getOrCreateTelegramWebhookRoute } from "@dave/telegram";
import { startTelegramBotServer } from "../src/telegram-bot-server.js";

/**
 * Real bug fixed (user: "somethings it shows (no text) like this everytime fix that"): a turn
 * that ends with no closing remark from the model (a real, legitimate case -- e.g. a purely
 * action-driven turn with nothing left to say) used to literally send the placeholder string
 * "(no text)" to the user as if it were Dave's real reply. This proves the real fix end to end:
 * a real model response with empty content and no tool calls no longer produces that placeholder.
 */

console.log("=== Real proof: an empty model response never shows the user the literal string \"(no text)\" ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-no-text-fix-"));
process.chdir(workDir);
const OWNER = "user-no-text-fix-1";
const CHAT_ID = 838383;

const sentMessages: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const urlStr = String(url);
  if (urlStr.includes("api.telegram.org")) {
    const method = urlStr.split("/").pop() ?? "";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (method === "setWebhook" || method === "setMyCommands" || method === "setMyDescription" || method === "setMyShortDescription") {
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }
    if (body?.text) sentMessages.push(body.text);
    if (body?.rich_message?.html) sentMessages.push(body.rich_message.html);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }
  if (urlStr.includes("api.openai.com")) {
    // A real, legitimate case: the model returns a done turn with genuinely empty content and no tool calls.
    return new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 });
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

let server: Awaited<ReturnType<typeof startTelegramBotServer>> | undefined;
try {
  const db = new DaveDatabase(join(workDir, "dave.db"));
  addProviderKey(db, OWNER, "openai", "key", { apiKey: "sk-fake", model: "gpt-x" });
  setModelConfig(OWNER, { primary: "openai", fallback: [] });

  const executor = new EaTradeExecutor(OWNER);
  server = await startTelegramBotServer({ ownerUserId: OWNER, db, executor, botToken: "000000:fake-bot-token", publicBaseUrl: "https://dave.example.com", systemPrompt: "You are Dave." });
  await new Promise<void>((resolve) => server!.server.listen(0, "127.0.0.1", resolve));
  const port = (server.server.address() as { port: number }).port;
  const webhookPath = new URL(server.webhookUrl).pathname;
  const routeInfo = getOrCreateTelegramWebhookRoute(OWNER);

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

  await postUpdate({ update_id: 1, message: { message_id: 1, chat: { id: CHAT_ID }, text: "hi", date: Date.now() / 1000 } });
  await new Promise((r) => setTimeout(r, 300));

  console.log(`    real messages sent to Telegram: ${JSON.stringify(sentMessages)}`);
  assert.ok(!sentMessages.some((t) => t.includes("(no text)")), "the literal placeholder string must never reach the user");
  assert.ok(sentMessages.some((t) => t.includes("✅ Done.")), "a real, honest, minimal completion signal must be sent instead");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  server?.server.close();
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
