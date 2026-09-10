import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { DaveDatabase } from "@dave/db";
import { EaTradeExecutor } from "@dave/ea-bridge";
import { addProviderKey, setModelConfig } from "@dave/brain";
import { proposeSettingsChange, listPendingLimitChanges, getRiskSettings } from "@dave/trading";
import { startTelegramBotServer } from "../src/telegram-bot-server.js";

/**
 * Real proof for item 11: "when Dave asks for approval, if the user answers via a normal typed
 * 'yes', it should NOT then ask again via UI buttons afterward... a typed 'yes' should be treated
 * as equivalent to tapping Approve, don't trigger a second UI prompt on top of it."
 */

console.log("=== Real proof: a typed \"yes\" answers a pending approval directly, no second UI prompt ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-typed-yes-"));
process.chdir(workDir);
const OWNER = "user-typed-yes-1";
const CHAT_ID = 111888;

const sentMessages: string[] = [];
let modelCallCount = 0;
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
  // If this real webhook-driven turn EVER reaches the model, the typed "yes" was NOT
  // intercepted as a real approval answer -- the whole point of this test is that it must not.
  modelCallCount++;
  return new Response(JSON.stringify({ choices: [{ message: { content: "This should never be reached." } }] }), { status: 200 });
}) as typeof fetch;

let server: Awaited<ReturnType<typeof startTelegramBotServer>> | undefined;
try {
  const db = new DaveDatabase(join(workDir, "dave.db"));
  addProviderKey(db, OWNER, "openai", "test key", { apiKey: "sk-real-fake" });
  setModelConfig(OWNER, { primary: "openai", fallback: [] });

  console.log("[1] Dave proposes a real settings change on its own initiative (SL -> 20 pips) -- genuinely pending, not applied...");
  const proposal = proposeSettingsChange(OWNER, "sl", "on", 20, "Volatility picked up, tightening SL.");
  assert.equal(proposal.applied, false);
  assert.equal(getRiskSettings(OWNER).slMode, "off", "must genuinely still be unapplied while pending");
  console.log(`    real pending change: ${JSON.stringify(listPendingLimitChanges(OWNER))}`);

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

  console.log("\n[2] The user types a plain \"yes\" (not a button tap) -- this must be treated as approving the pending change directly...");
  await postUpdate({ update_id: 1, message: { message_id: 1, chat: { id: CHAT_ID }, text: "yes", date: Date.now() / 1000 } });
  await new Promise((r) => setTimeout(r, 150));

  console.log(`    real messages sent: ${JSON.stringify(sentMessages)}`);
  console.log(`    real model calls made: ${modelCallCount} (must be 0 -- the typed "yes" must never reach the agent loop/model)`);
  assert.equal(modelCallCount, 0, "a typed approval answer must be intercepted before the agent loop, never forwarded to the model");

  assert.equal(getRiskSettings(OWNER).slMode, "on", "the real pending change must genuinely be applied now");
  assert.equal(getRiskSettings(OWNER).slValue, 20);
  assert.equal(listPendingLimitChanges(OWNER).length, 0, "the pending change must genuinely be cleared, not left dangling");

  const approvalMsg = sentMessages.find((t) => t.includes("Approved"));
  assert.ok(approvalMsg, "a real approval confirmation must be sent");
  console.log(`    real confirmation: "${approvalMsg}"`);

  console.log("\n[3] No SECOND approval prompt was sent on top of the typed answer...");
  const secondPromptCount = sentMessages.filter((t) => t.includes("Approval needed")).length;
  console.log(`    real 'Approval needed' prompts sent during this whole flow: ${secondPromptCount} (must be 0 -- it was already sent before this test's timeline)`);
  assert.equal(secondPromptCount, 0);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  server?.server.close();
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
