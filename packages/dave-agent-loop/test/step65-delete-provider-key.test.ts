import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { TelegramClient } from "@dave/telegram";
import { addProviderKey, listProviderKeys } from "@dave/brain";
import { dispatchCallback, type CommandRouterDeps } from "../src/command-router.js";

/**
 * Real proof for item 1: "add the ability to delete a single stored API key from a provider...
 * confirm via /providers, tap into a provider, each key has a delete option."
 */

console.log("=== Real proof: delete a single stored provider API key from Telegram ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-delete-key-"));
const OWNER = "user-delete-key-1";
const CHAT_ID = 444111;
const modelConfigPath = join(process.cwd(), "data", "brain", `${OWNER}-model-config.json`);
rmSync(modelConfigPath, { force: true });

const sentMessages: Array<{ text: string; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } }> = [];
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

  console.log("[1] Two real stored keys for openai, the provider's detail screen shows a real Delete button per key...");
  const key1 = addProviderKey(db, OWNER, "openai", "key one", { apiKey: "sk-one" });
  addProviderKey(db, OWNER, "openai", "key two", { apiKey: "sk-two" });
  sentMessages.length = 0;
  await dispatchCallback(deps, { id: "cb1", data: "provider:openai", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  const detailButtons = sentMessages[0].reply_markup!.inline_keyboard;
  console.log(`    real rows: ${JSON.stringify(detailButtons.map((r) => r.map((b) => b.text)))}`);
  const deleteButtons = detailButtons.flat().filter((b) => b.callback_data.startsWith("deletekey:"));
  assert.equal(deleteButtons.length, 2, "each of the 2 real stored keys must have its own real Delete button");

  console.log("\n[2] Tapping Delete on the (primary) key one genuinely removes it, and auto-promotes the remaining key to primary...");
  const deleteKey1Button = detailButtons.flat().find((b) => b.callback_data === `deletekey:${key1.id}`)!;
  sentMessages.length = 0;
  await dispatchCallback(deps, { id: "cb2", data: deleteKey1Button.callback_data, message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  const remaining = listProviderKeys(db, OWNER, "openai");
  console.log(`    real remaining keys: ${remaining.map((k) => k.label).join(", ")}`);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].label, "key two");
  assert.ok(remaining[0].isPrimary, "the remaining key must genuinely become primary after the old primary was deleted");

  const confirmMsg = sentMessages.find((m) => m.text.includes("Deleted"));
  console.log(`    real confirmation: "${confirmMsg?.text}"`);
  assert.ok(confirmMsg, "a real confirmation message must be sent");

  console.log("\n[3] Deleting the LAST key leaves the provider honestly showing 'no keys stored'...");
  sentMessages.length = 0;
  await dispatchCallback(deps, { id: "cb3", data: `deletekey:${remaining[0].id}`, message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  const finalKeys = listProviderKeys(db, OWNER, "openai");
  assert.equal(finalKeys.length, 0);
  const finalView = sentMessages.find((m) => m.text.includes("No keys stored yet"));
  console.log(`    real final screen: "${finalView?.text.split("\n")[0]}" -- "${finalView?.text.split("\n")[2]}"`);
  assert.ok(finalView, "the re-rendered screen must honestly show no keys stored, not a stale key list");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
  rmSync(modelConfigPath, { force: true });
}
