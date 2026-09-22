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
 * Real proof of the third reversal (the trader, live, explicit: "hardcode this so instead of the
 * bot calling it it's already hardcoded"): the live progress indicator now shows on EVERY real
 * chat turn automatically -- driven off real AgentStep tool-call events (agent-loop.ts's `onStep`)
 * -- with zero model cooperation required. This is the end-to-end replacement for the removed
 * step110 test (which proved the now-deleted model-callable tg_thinking/tg_thinking_update/
 * tg_finalize tools) -- same real webhook -> runAgentTurn -> Telegram send path step79/step81
 * already exercise, but this time proving the automatic wrapper itself: a real progress message
 * created, live-updated off a real tool call the model made with NO thinking-related instruction
 * or tool involved, then cleanly deleted right before the real final answer sends.
 */

console.log("=== Real proof: the live progress indicator is fully automatic, no model tool-call needed ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-auto-indicator-"));
process.chdir(workDir);
const OWNER = "user-auto-indicator-1";
const CHAT_ID = 424242;

const calls: { method: string; body: Record<string, unknown> }[] = [];
let openaiCallCount = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const urlStr = String(url);
  if (urlStr.includes("api.telegram.org")) {
    const method = urlStr.split("/").pop() ?? "";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (method === "setWebhook" || method === "setMyCommands" || method === "setMyDescription" || method === "setMyShortDescription") {
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }
    calls.push({ method, body: body ?? {} });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 900 + calls.length } }), { status: 200 });
  }
  if (urlStr.includes("api.openai.com")) {
    openaiCallCount++;
    if (openaiCallCount === 1) {
      // First model turn: a real tool call, no text -- exactly the kind of step the automatic
      // wrapper must narrate on its own, with no tg_thinking-style tool anywhere in sight.
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "recall_memory", arguments: "{}" } }] } }],
        }),
        { status: 200 }
      );
    }
    // Second model turn: the real final answer.
    return new Response(JSON.stringify({ choices: [{ message: { content: "All set." } }] }), { status: 200 });
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

  await postUpdate({ update_id: 1, message: { message_id: 1, chat: { id: CHAT_ID }, text: "check my memory then confirm", date: Date.now() / 1000 } });
  await new Promise((r) => setTimeout(r, 500));

  console.log(`    real Telegram calls: ${calls.map((c) => c.method).join(" -> ")}`);

  assert.ok(calls.some((c) => c.method === "sendChatAction"), "the automatic wrapper must start a real chat action -- nothing to call, it just happens");

  // This test's subject is that the narration is AUTOMATIC -- derived from the real AgentStep,
  // with no model cooperation. That is unchanged. What changed in step153 is where it lands: the
  // invisible <tg-thinking> draft rather than a real progress message (the real message beside the
  // draft was the trader's "sending two times" bug).
  const progressDraft = calls.find(
    (c) => c.method === "sendRichMessageDraft" && String((c.body.rich_message as { markdown?: string } | undefined)?.markdown ?? "").includes("recall memory")
  );
  assert.ok(progressDraft, "the real tool call (recall_memory) must be narrated into the thinking draft -- derived from the real AgentStep, no model cooperation involved");
  const draftMd = String((progressDraft!.body.rich_message as { markdown?: string }).markdown);
  assert.ok(draftMd.startsWith("⁠"), "the draft body is invisible, so it shows as an indicator and not as a stray half-message");
  assert.ok(draftMd.includes("<tg-thinking>"), "and carries the real thinking tag");

  // The duplicate guard, now stronger than before: across the WHOLE turn there is exactly one real
  // message -- the answer. Progress never arrives as a message, so there is nothing to delete.
  const realMessages = calls.filter((c) => c.method === "sendMessage");
  assert.equal(realMessages.length, 1, `exactly one real message for the whole turn -- got ${realMessages.length}: ${realMessages.map((m) => JSON.stringify(m.body.text)).join(", ")}`);
  assert.equal(realMessages[0].body.text, "All set.", "and it is the final answer");
  assert.equal(calls.filter((c) => c.method === "deleteMessage").length, 0, "nothing to delete -- which is why it no longer appears to delete itself");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  server?.server.close();
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
