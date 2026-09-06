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

/**
 * Real proof for item 7's other half: "inline-button-based questions Dave asks aren't being
 * received/processed correctly when the user answers -- this may be a different code path than
 * the settings-button callbacks already confirmed working, so test it specifically." Before this,
 * ask_user had NO options/buttons capability at all, and even a hypothetical askuser: callback
 * had no handler anywhere in dispatchCallback -- a tap would have been silently swallowed.
 * Drives a real webhook-driven agent turn where the model calls ask_user WITH options, confirms
 * real inline buttons are sent, then drives a real callback_query button tap and confirms the
 * SAME paused loop is genuinely resumed with that option's text -- a different code path from the
 * free-text resume already covered by step43/step45.
 */

console.log("=== Real proof: inline-button ask_user questions are genuinely received and resumed ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-askuser-buttons-"));
process.chdir(workDir);
const OWNER = "user-askuser-buttons-1";
const CHAT_ID = 444555;

const sentMessages: Array<{ text?: string; html?: string; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } }> = [];
const answeredCallbacks: Array<{ id: string; text?: string }> = [];
let modelCallCount = 0;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const urlStr = String(url);
  if (urlStr.includes("api.telegram.org")) {
    const method = urlStr.split("/").pop() ?? "";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (method === "answerCallbackQuery") {
      answeredCallbacks.push({ id: body.callback_query_id, text: body.text });
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }
    if (body?.text) sentMessages.push({ text: body.text, reply_markup: body.reply_markup });
    if (body?.rich_message?.html) sentMessages.push({ html: body.rich_message.html });
    if (method === "setWebhook" || method === "setMyCommands" || method === "setMyDescription" || method === "setMyShortDescription") {
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }
  // The real (mocked) model call: first call genuinely invokes ask_user WITH options; the
  // second call (after the real button tap resumes the loop) must see the real chosen answer.
  modelCallCount++;
  const body = init?.body ? JSON.parse(init.body as string) : undefined;
  if (modelCallCount === 1) {
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: "call-ask-1", type: "function", function: { name: "ask_user", arguments: JSON.stringify({ question: "Which pair should I look at?", options: ["EURUSD", "GBPUSD", "XAUUSD"] }) } }] } }] }),
      { status: 200 }
    );
  }
  const toolMsg = (body?.messages as { role: string; tool_call_id?: string; content?: string }[] | undefined)?.find((m) => m.role === "tool" && m.tool_call_id === "call-ask-1");
  return new Response(
    JSON.stringify({ choices: [{ message: { content: `Got it, real answer received: ${toolMsg?.content ?? "MISSING"}` } }] }),
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

  console.log("[1] A real message causes the model to genuinely call ask_user WITH options -- real inline buttons must be sent...");
  await postUpdate({ update_id: 1, message: { message_id: 1, chat: { id: CHAT_ID }, text: "find me a setup", date: Date.now() / 1000 } });
  await new Promise((r) => setTimeout(r, 150));

  const buttonMsg = sentMessages.find((m) => m.reply_markup);
  console.log(`    real messages sent: ${JSON.stringify(sentMessages)}`);
  assert.ok(buttonMsg, "a real message with inline buttons must have been sent for the ask_user options");
  const buttons = buttonMsg!.reply_markup!.inline_keyboard.flat();
  console.log(`    real buttons: ${buttons.map((b) => `${b.text} -> ${b.callback_data}`).join(" | ")}`);
  assert.deepEqual(buttons.map((b) => b.text), ["EURUSD", "GBPUSD", "XAUUSD"]);
  assert.ok(buttons.every((b) => b.callback_data.startsWith("askuser:call-ask-1:")), "each button's callback_data must genuinely carry the real paused toolCallId");

  console.log("\n[2] A real button tap (callback_query) genuinely resumes the SAME paused loop with that option's text, and answers the callback...");
  sentMessages.length = 0;
  const gbpButton = buttons.find((b) => b.text === "GBPUSD")!;
  await postUpdate({ update_id: 2, callback_query: { id: "cb-ask-1", data: gbpButton.callback_data, message: { message_id: 5, chat: { id: CHAT_ID } }, from: { id: 1 } } });
  await new Promise((r) => setTimeout(r, 150));

  console.log(`    real answerCallbackQuery calls: ${JSON.stringify(answeredCallbacks)}`);
  assert.ok(answeredCallbacks.some((c) => c.id === "cb-ask-1" && c.text?.includes("GBPUSD")), "the real button tap must genuinely be acknowledged");

  const combined = sentMessages.map((m) => m.text ?? m.html ?? "").join("\n");
  console.log(`    real messages after the tap: ${JSON.stringify(sentMessages)}`);
  assert.ok(combined.includes("Got it, real answer received: GBPUSD"), "the resumed model call must genuinely have received the real chosen answer as the tool result, and the final reply must genuinely reach Telegram");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  server?.server.close();
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
