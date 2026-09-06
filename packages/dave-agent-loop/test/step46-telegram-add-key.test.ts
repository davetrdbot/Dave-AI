import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { TelegramClient } from "@dave/telegram";
import { listProviderKeys } from "@dave/brain";
import { dispatchCallback, tryHandlePendingKeyEntry, type CommandRouterDeps } from "../src/command-router.js";

/**
 * Real proof for the user's explicit ask: "I can set up to 10 keys in the telegram and paste
 * the settable credentials in telegram" -- /providers could drill into a provider and
 * activate an EXISTING key, but there was no real way to ADD one from Telegram at all, only
 * through the admin panel. This proves the real fix: tapping "Add key(s)" primes capture, and
 * the user's next message (single key OR multiple, one per line) is genuinely stored via the
 * real bulk-add path, with per-line results reported back.
 */

console.log("=== Real proof: adding provider keys directly from Telegram (single + bulk) ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-telegram-addkey-"));
const OWNER = "user-telegram-addkey-1";
const CHAT_ID = 777222;

const sentMessages: Array<{ text: string; reply_markup?: { inline_keyboard: { text: string }[][] } }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (_url: string, init?: RequestInit) => {
  const body = init?.body ? JSON.parse(init.body as string) : undefined;
  if (body?.text) sentMessages.push({ text: body.text, reply_markup: body.reply_markup });
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
}) as typeof fetch;

try {
  const db = new DaveDatabase(join(workDir, "dave.db"));
  const client = new TelegramClient("000000:fake-token-for-transport-mock");
  const deps: CommandRouterDeps = { db, client, userId: OWNER, publicBaseUrl: "https://dave.example.com" };

  console.log("[1] Tapping 'Add key(s)' on a provider genuinely primes capture and prompts the user...");
  sentMessages.length = 0;
  await dispatchCallback(deps, { id: "cb1", data: "addkey:openai", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  assert.match(sentMessages[0].text, /Reply with your openai API key/);

  console.log("\n[2] A single pasted key is genuinely stored as a real provider key...");
  const consumedSingle = await tryHandlePendingKeyEntry(deps, CHAT_ID, "sk-real-openai-key-1");
  assert.equal(consumedSingle, true);
  let keys = listProviderKeys(db, OWNER, "openai");
  console.log(`    real stored keys for openai: ${keys.length}`);
  assert.equal(keys.length, 1);
  assert.equal(keys[0].config.apiKey, "sk-real-openai-key-1");

  console.log("\n[3] A normal free-text message with no pending add is correctly NOT consumed...");
  const notConsumed = await tryHandlePendingKeyEntry(deps, CHAT_ID, "just chatting with Dave");
  assert.equal(notConsumed, false);

  console.log("\n[4] Bulk paste (multiple keys, one per line, up to 10) genuinely stores each individually...");
  await dispatchCallback(deps, { id: "cb2", data: "addkey:groq", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  sentMessages.length = 0;
  const bulkText = "gsk-real-key-1\ngsk-real-key-2\n\ngsk-real-key-3";
  const consumedBulk = await tryHandlePendingKeyEntry(deps, CHAT_ID, bulkText);
  assert.equal(consumedBulk, true);
  keys = listProviderKeys(db, OWNER, "groq");
  console.log(`    real stored keys for groq: ${keys.length} (blank line correctly skipped)`);
  assert.equal(keys.length, 3);
  console.log(`    real per-line report sent: "${sentMessages[0].text.split("\n").slice(1).join(" | ")}"`);
  assert.match(sentMessages[0].text, /Line 1: OK/);
  assert.match(sentMessages[0].text, /Line 3: OK/);

  console.log("\n[5] The 'Add key(s)' button genuinely disappears once the real 10-key cap is hit...");
  sentMessages.length = 0;
  await dispatchCallback(deps, { id: "cb3", data: "addkey:groq", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  await tryHandlePendingKeyEntry(deps, CHAT_ID, Array.from({ length: 7 }, (_, i) => `gsk-real-key-${i + 4}`).join("\n"));
  assert.equal(listProviderKeys(db, OWNER, "groq").length, 10);
  sentMessages.length = 0;
  await dispatchCallback(deps, { id: "cb4", data: "provider:groq", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  const detailCall = sentMessages[sentMessages.length - 1];
  const buttonTexts = detailCall?.reply_markup?.inline_keyboard.flat().map((b) => b.text) ?? [];
  console.log(`    buttons at 10/10 keys: ${JSON.stringify(buttonTexts.filter((t) => t.includes("Add key")))} (must be empty)`);
  assert.ok(!buttonTexts.some((t) => t.includes("Add key")), "the Add key(s) button must genuinely disappear once the real 10-key cap is hit");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}
