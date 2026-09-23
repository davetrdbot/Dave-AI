import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";

const workDir = mkdtempSync(join(tmpdir(), "dave-fresh-pairing-"));
process.env.DAVE_DATA_ROOT = workDir;

/**
 * A trader forked the repo, deployed it, paired Telegram from the web panel -- the bot asked
 * "What should I call you?" and then nothing: no command menu, no replies. Reproduced end to end
 * against a stand-in Telegram. This pins the fixes:
 *   - pairing works without knowing your chat ID, and without the bot being able to message first;
 *   - the pairing code is marked read, so it never reaches Dave as a chat message;
 *   - an abandoned pairing expires instead of holding the bot offline;
 *   - no public URL -> the bot polls Telegram instead of never coming online;
 *   - a webhook something else removed is put back;
 *   - the running state is written where the web panel can read it.
 */

// --- a stand-in Telegram, strict on the rules that matter ---------------------------------------
let webhook: string | null = null;
let queue: any[] = [];
let nextId = 1;
const sent: { chat_id: number; text: string }[] = [];
let blockStrangers = true; // Telegram: a bot can't message someone who never pressed Start
const started = new Set<number>();
const server: Server = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const p = body ? JSON.parse(body) : {};
  const method = (req.url ?? "").split("/").pop();
  const ok = (result: unknown) => res.end(JSON.stringify({ ok: true, result }));
  const fail = (code: number, description: string) => res.end(JSON.stringify({ ok: false, error_code: code, description }));
  switch (method) {
    case "getMe":
      return ok({ id: 1, is_bot: true, username: "fresh_bot" });
    case "sendMessage":
      if (blockStrangers && !started.has(p.chat_id)) return fail(403, "Forbidden: bot can't initiate conversation with a user");
      sent.push({ chat_id: p.chat_id, text: p.text });
      return ok({ message_id: sent.length, chat: { id: p.chat_id } });
    case "deleteWebhook":
      webhook = null;
      return ok(true);
    case "setWebhook":
      webhook = p.url;
      return ok(true);
    case "getWebhookInfo":
      return ok({ url: webhook ?? "", pending_update_count: queue.length });
    case "getUpdates":
      if (webhook) return fail(409, "Conflict: can't use getUpdates method while webhook is active");
      if (p.offset) queue = queue.filter((u) => u.update_id >= p.offset);
      return ok(queue);
    default:
      return ok(true);
  }
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
process.env.TELEGRAM_API_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const userSays = (chatId: number, text: string) => {
  if (text === "/start") started.add(chatId);
  queue.push({ update_id: nextId++, message: { message_id: nextId, chat: { id: chatId, type: "private" }, text, date: 0 } });
};

const { DaveDatabase } = await import("@dave/db");
const tg = await import("../src/index.js");
const { extractPreferredName } = await import("@dave/core");

console.log("=== Step 161: a fresh install pairs, comes online, and answers ===\n");
const db = new DaveDatabase(join(workDir, "t.db"));
const USER = "default";

console.log("[1] No chat ID, and a bot that can't message first: pairing still starts\n");
const start = await tg.startTelegramOtpPairing(db, USER, "123:ABC");
assert.equal(start.sentToChat, false);
assert.equal(start.botUsername, "fresh_bot");
assert.equal(tg.hasPendingTelegramPairing(db, USER), true);
// A chat ID for someone who never pressed Start: the courtesy message fails, pairing does not.
const withChat = await tg.startTelegramOtpPairing(db, USER, "123:ABC", 4242);
assert.equal(withChat.sentToChat, false, "Telegram refused -- reported, not thrown");
console.log("   ✓\n");

console.log("[2] The chat that sends the code becomes the chat -- when none was entered\n");
const fresh = await tg.startTelegramOtpPairing(db, USER, "123:ABC");
userSays(777, "/start");
userSays(777, "hi?");
let check = await tg.checkTelegramOtpPairing(db, USER);
assert.equal(check.confirmed, false);
assert.match(check.reason!, new RegExp(`Send ${fresh.otp}`), "says exactly what to send");
userSays(777, fresh.otp);
check = await tg.checkTelegramOtpPairing(db, USER);
assert.equal(check.confirmed, true);
assert.deepEqual(tg.getTelegramPairingStatus(db, USER), { paired: true, chatId: 777 });
assert.equal(queue.length, 0, "everything up to the code is marked read -- Dave never sees the code as chat");
assert.equal(tg.hasPendingTelegramPairing(db, USER), false);
assert.ok(sent.some((m) => m.chat_id === 777 && /What should I call you/.test(m.text)), "onboarding starts");
console.log("   ✓\n");

console.log("[3] A code from the wrong chat is named, not silently ignored\n");
const again = await tg.startTelegramOtpPairing(db, USER, "123:ABC", 1111);
userSays(2222, again.otp);
check = await tg.checkTelegramOtpPairing(db, USER);
assert.equal(check.confirmed, false);
assert.match(check.reason!, /chat 2222/);
console.log("   ✓\n");

console.log("[4] An abandoned pairing stops holding the bot off Telegram after 15 minutes\n");
assert.equal(tg.hasPendingTelegramPairing(db, USER), true);
assert.equal(tg.hasPendingTelegramPairing(db, USER, Date.now() + tg.PAIRING_WINDOW_MS + 1000), false);
// clear it for the delivery tests
userSays(1111, again.otp);
assert.equal((await tg.checkTelegramOtpPairing(db, USER)).confirmed, true);
console.log("   ✓\n");

console.log("[5] No public URL: the bot polls, and the status says so\n");
const client = new tg.TelegramClient("123:ABC");
const got: string[] = [];
userSays(1111, "hello from a VPS");
const polling = await tg.startUpdateDelivery({ client, db, ownerUserId: USER, onUpdate: (_u, up) => void got.push(up.message?.text ?? ""), username: "fresh_bot" });
assert.equal(polling.mode, "polling");
for (let i = 0; i < 50 && got.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
polling.stop();
assert.deepEqual(got, ["hello from a VPS"]);
assert.equal(tg.readTelegramStatus()?.state, "online");
assert.equal(tg.readTelegramStatus()?.mode, "polling");
console.log("   ✓\n");

console.log("[6] Public URL: webhook set, and put back when something removes it\n");
const hooked = await tg.startUpdateDelivery({ client, db, ownerUserId: USER, publicBaseUrl: "https://bot.example.com", onUpdate: () => undefined, watchdogMs: 50 });
assert.equal(hooked.mode, "webhook");
assert.equal(webhook, hooked.webhookUrl);
await client.deleteWebhook(); // e.g. someone pairs again, or another tool used the token
for (let i = 0; i < 50 && webhook === null; i++) await new Promise((r) => setTimeout(r, 20));
assert.equal(webhook, hooked.webhookUrl, "watchdog re-registered it");
// ...but never while a pairing is waiting for its code (its check needs the webhook off).
await tg.startTelegramOtpPairing(db, USER, "123:ABC");
await new Promise((r) => setTimeout(r, 200));
assert.equal(webhook, null, "left off during pairing");
hooked.stop();
console.log("   ✓\n");

console.log("[7] Onboarding takes the name out of a sentence\n");
assert.equal(extractPreferredName("call me Sam"), "Sam");
assert.equal(extractPreferredName("I'm Ada."), "Ada");
assert.equal(extractPreferredName("my name is Jean Luc"), "Jean Luc");
assert.equal(extractPreferredName("Kofi"), "Kofi");
console.log("   ✓\n");

server.close();
console.log("=== ALL ASSERTIONS PASSED ===");
process.exit(0);
