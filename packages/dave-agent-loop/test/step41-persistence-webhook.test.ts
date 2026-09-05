import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { TelegramClient, createTelegramWebhookServer, getOrCreateTelegramWebhookRoute } from "@dave/telegram";
import { loadConversationHistory, saveConversationHistory, clearConversationHistory } from "../src/index.js";

console.log("=== Real proof: persisted conversation history + real Telegram webhook server ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-persist-webhook-"));
const OWNER = "user-persist-1";

try {
  console.log("[1] Conversation history genuinely survives a process restart (new DaveDatabase instance, same file)...");
  const dbPath = join(workDir, "dave.db");
  const dbBeforeRestart = new DaveDatabase(dbPath);
  saveConversationHistory(dbBeforeRestart, OWNER, [
    { role: "system", content: "You are Dave." },
    { role: "user", content: "My name is Inyang David." },
    { role: "assistant", content: "Good to meet you, Inyang David." },
  ]);
  // Simulate a real restart: brand-new DaveDatabase instance against the same file, not the same in-memory object.
  const dbAfterRestart = new DaveDatabase(dbPath);
  const reloaded = loadConversationHistory(dbAfterRestart, OWNER);
  assert.equal(reloaded.length, 3);
  assert.equal(reloaded[1].content, "My name is Inyang David.");
  console.log(`    ${reloaded.length} real messages survived a simulated restart, including "${reloaded[1].content}"`);

  console.log("\n[2] History is capped so a long-running bot's own memory doesn't grow the prompt without bound...");
  const long = [{ role: "system" as const, content: "sys" }, ...Array.from({ length: 100 }, (_, i) => ({ role: "user" as const, content: `msg ${i}` }))];
  saveConversationHistory(dbAfterRestart, OWNER, long);
  const capped = loadConversationHistory(dbAfterRestart, OWNER);
  assert.ok(capped.length <= 60, `expected a capped history, got ${capped.length}`);
  assert.equal(capped[0].role, "system", "the leading system message must survive trimming");
  assert.equal(capped[capped.length - 1].content, "msg 99", "the most RECENT messages must be kept, not the oldest");
  console.log(`    103 messages -> capped to ${capped.length}, oldest trimmed, system message + most recent kept`);

  clearConversationHistory(dbAfterRestart, OWNER);
  assert.equal(loadConversationHistory(dbAfterRestart, OWNER).length, 0);
  console.log("    clearConversationHistory genuinely empties it");

  console.log("\n[3] Real per-user webhook route is persisted (same path token across calls, not regenerated)...");
  const route1 = getOrCreateTelegramWebhookRoute(OWNER);
  const route2 = getOrCreateTelegramWebhookRoute(OWNER);
  assert.equal(route1.path, route2.path);
  assert.equal(route1.secretToken, route2.secretToken);
  console.log(`    stable route: ${route1.path}`);

  console.log("\n[4] Real webhook server rejects a POST with the WRONG (or missing) secret token...");
  const server = createTelegramWebhookServer({ onUpdate: async () => {} });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a real TCP address");
  const base = `http://127.0.0.1:${address.port}`;

  const wrongSecret = await fetch(`${base}${route1.path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "wrong" },
    body: JSON.stringify({ update_id: 1 }),
  });
  assert.equal(wrongSecret.status, 401);
  console.log(`    wrong secret -> HTTP ${wrongSecret.status}, rejected`);

  const unknownRoute = await fetch(`${base}/hooks/telegram/not-a-real-token`, { method: "POST", body: "{}" });
  assert.equal(unknownRoute.status, 404);
  console.log(`    unknown route token -> HTTP ${unknownRoute.status}, rejected`);

  console.log("\n[5] A real POST with the correct secret token genuinely reaches onUpdate() with the real parsed Update...");
  let received: any = null;
  const server2 = createTelegramWebhookServer({
    onUpdate: async (userId, update) => {
      received = { userId, update };
    },
  });
  await new Promise<void>((resolve) => server2.listen(0, "127.0.0.1", resolve));
  const address2 = server2.address();
  if (!address2 || typeof address2 === "string") throw new Error("expected a real TCP address");
  const base2 = `http://127.0.0.1:${address2.port}`;

  const realUpdate = { update_id: 42, message: { message_id: 1, chat: { id: 8235751653, type: "private" }, date: Date.now(), text: "hello dave" } };
  const ok = await fetch(`${base2}${route1.path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": route1.secretToken },
    body: JSON.stringify(realUpdate),
  });
  assert.equal(ok.status, 200);
  await new Promise((r) => setTimeout(r, 50)); // onUpdate is fired after the 200 ack, per real Telegram webhook contract
  assert.equal(received.userId, OWNER);
  assert.equal(received.update.message.text, "hello dave");
  console.log(`    real update reached the handler: chat=${received.update.message.chat.id}, text="${received.update.message.text}"`);

  server.close();
  server2.close();

  const REAL_TOKEN = process.env.TG_TEST_TOKEN;
  if (REAL_TOKEN) {
    console.log("\n[6] Real setWebhook/getWebhookInfo/deleteWebhook round trip against the real live Telegram Bot API...");
    const client = new TelegramClient(REAL_TOKEN);
    await client.setWebhook({ url: "https://example.com/hooks/telegram/probe", secret_token: "probe-secret" });
    const info = await client.getWebhookInfo();
    assert.equal(info.url, "https://example.com/hooks/telegram/probe");
    console.log(`    real getWebhookInfo() confirms Telegram registered it: ${JSON.stringify(info)}`);
    await client.deleteWebhook();
    const infoAfter = await client.getWebhookInfo();
    assert.equal(infoAfter.url, "");
    console.log("    deleteWebhook() confirmed via a real getWebhookInfo() showing no url");
  } else {
    console.log("\n(No TG_TEST_TOKEN env var -- skipping the live setWebhook/getWebhookInfo/deleteWebhook round trip.)");
  }

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
