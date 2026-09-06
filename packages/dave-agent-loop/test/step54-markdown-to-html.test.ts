import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { DaveDatabase } from "@dave/db";
import { DavemaClient } from "@dave/davema";
import { EaTradeExecutor } from "@dave/ea-bridge";
import { addProviderKey, setModelConfig } from "@dave/brain";
import { markdownToTelegramHtml } from "@dave/telegram";
import { startTelegramBotServer } from "../src/telegram-bot-server.js";

/**
 * Real proof for the live-production bug report: literal `**inyang David**` and a raw
 * `| Role | What it can do |` markdown table showing up as plain text in Telegram instead of
 * real rich formatting. Proves both:
 *   (a) markdownToTelegramHtml() itself genuinely converts **bold** and a pipe table to real
 *       Telegram HTML (<b>, a monospace <pre> table), not leaving asterisks/pipes behind.
 *   (b) it's genuinely wired into the real send path -- a real webhook-driven agent turn whose
 *       model reply contains raw markdown ends up sending real HTML to Telegram, not the raw text.
 */

console.log("=== Real proof: markdown (**bold**, pipe tables) converts to real Telegram HTML ===\n");

console.log("[1] Unit-level: markdownToTelegramHtml() converts **bold** to real <b> HTML, no leftover asterisks...");
const boldOut = markdownToTelegramHtml("Good to meet you, **inyang David**!");
console.log(`    in:  Good to meet you, **inyang David**!`);
console.log(`    out: ${boldOut}`);
assert.equal(boldOut, "Good to meet you, <b>inyang David</b>!");
assert.ok(!boldOut.includes("**"), "no raw ** should survive");

console.log("\n[2] Unit-level: a raw markdown pipe table converts to a real monospace <pre> block, not raw pipes...");
const tableIn = "Here's what each role can do:\n\n| Role | What it can do |\n|------|------|\n| Scout | Finds setups |\n| Executor | Places trades |\n";
const tableOut = markdownToTelegramHtml(tableIn);
console.log(`    out: ${tableOut}`);
assert.ok(tableOut.includes("<pre>"), "must contain a real <pre> block");
assert.ok(!tableOut.includes("| Role | What it can do |"), "raw pipe syntax must not survive");
assert.ok(tableOut.includes("Scout"));
assert.ok(tableOut.includes("Executor"));

console.log("\n[3] End-to-end: a real webhook-driven agent turn whose model reply contains raw markdown genuinely sends real HTML to Telegram...");

const workDir = mkdtempSync(join(tmpdir(), "dave-md-html-"));
process.chdir(workDir);
const OWNER = "user-mdhtml-1";
const CHAT_ID = 555444;

const sentMessages: Array<{ text?: string; html?: string; parse_mode?: string }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const urlStr = String(url);
  if (urlStr.includes("api.telegram.org")) {
    const method = urlStr.split("/").pop() ?? "";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (body?.text) sentMessages.push({ text: body.text, parse_mode: body.parse_mode });
    if (body?.rich_message?.html) sentMessages.push({ html: body.rich_message.html });
    if (method === "setWebhook" || method === "setMyCommands" || method === "setMyDescription" || method === "setMyShortDescription") {
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }
  // The real provider HTTP call -- return a raw markdown-flavored reply, exactly like a real LLM.
  return new Response(
    JSON.stringify({ choices: [{ message: { content: "Good to meet you, **inyang David**!\n\n| Role | What it can do |\n|------|------|\n| Scout | Finds setups |\n" } }] }),
    { status: 200 }
  );
}) as typeof fetch;

let server: Awaited<ReturnType<typeof startTelegramBotServer>> | undefined;
try {
  const db = new DaveDatabase(join(workDir, "dave.db"));
  addProviderKey(db, OWNER, "openai", "test key", { apiKey: "sk-real-fake" });
  setModelConfig(OWNER, { primary: "openai", fallback: [] });

  const davema = new DavemaClient(undefined, "http://127.0.0.1:1");
  const executor = new EaTradeExecutor(OWNER);

  server = await startTelegramBotServer({
    ownerUserId: OWNER,
    db,
    davema,
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

  await postUpdate({ update_id: 1, message: { message_id: 1, chat: { id: CHAT_ID }, text: "who are you", date: Date.now() / 1000 } });
  await new Promise((r) => setTimeout(r, 100));

  console.log(`    real messages sent to Telegram: ${JSON.stringify(sentMessages)}`);
  assert.ok(sentMessages.length > 0, "at least one real message must have been sent");
  const combined = sentMessages.map((m) => m.text ?? m.html ?? "").join("\n");
  assert.ok(!combined.includes("**"), "no raw ** markdown may reach Telegram");
  assert.ok(!combined.includes("| Role |"), "no raw pipe-table syntax may reach Telegram");
  assert.ok(combined.includes("<b>inyang David</b>"), "real <b> HTML must be present");
  assert.ok(combined.includes("<pre>"), "real <pre> table HTML must be present");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  server?.server.close();
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
