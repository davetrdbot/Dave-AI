import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { TelegramClient, DAVE_COMMANDS, registerDefaultCommandMenu } from "@dave/telegram";
import { listE2BKeys } from "@dave/e2b";
import { getTtsProviderKey } from "@dave/notifications";
import { dispatchCommand, dispatchCallback, tryHandlePendingTtsKeyEntry, tryHandlePendingE2BKeyEntry, type CommandRouterDeps } from "../src/command-router.js";

/**
 * Real proof for the user's explicit asks:
 *  1) "/menu should be UI, not a list of commands" -- /menu now renders a real inline
 *     keyboard, and tapping a button runs the exact same handler the equivalent slash
 *     command would.
 *  2) "setMyCommands has a real description on every command, with an emoji prefix" --
 *     re-verified against the real registerDefaultCommandMenu() call.
 *  3) "elevenlabs, e2b... should be settable in the telegram" -- both keys can now be set
 *     from a real Telegram message, not just the admin panel.
 */

console.log("=== Real proof: /menu as real UI, command emoji, ElevenLabs/E2B keys settable from Telegram ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-menu-keys-"));
const OWNER = "user-menu-keys-1";
const CHAT_ID = 333444;

const sentTelegramCalls: Array<{ method: string; body: unknown }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const method = String(url).split("/").pop() ?? "";
  const body = init?.body ? JSON.parse(init.body as string) : undefined;
  sentTelegramCalls.push({ method, body });
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
}) as typeof fetch;

try {
  const db = new DaveDatabase(join(workDir, "dave.db"));
  const client = new TelegramClient("000000:fake-token-for-transport-mock");
  const deps: CommandRouterDeps = { db, client, userId: OWNER, publicBaseUrl: "https://dave.example.com" };

  console.log("[1] /menu renders a REAL inline keyboard, not a text dump...");
  sentTelegramCalls.length = 0;
  await dispatchCommand(deps, CHAT_ID, `${OWNER}:${CHAT_ID}`, "/menu");
  const menuBody = sentTelegramCalls[0].body as { text: string; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } };
  console.log(`    text: "${menuBody.text}"`);
  assert.ok(menuBody.reply_markup, "/menu must send a real reply_markup keyboard");
  const menuButtons = menuBody.reply_markup!.inline_keyboard.flat();
  console.log(`    real buttons: ${menuButtons.map((b) => b.text).join(", ")}`);
  assert.ok(menuButtons.length >= 9, "menu must offer at least the 9 real commands as buttons");
  assert.ok(menuButtons.every((b) => b.callback_data.startsWith("menucmd:")), "every menu button must route through the real command dispatch");
  assert.ok(!menuBody.text.includes("--"), "the message body itself must not be the old '/command -- description' text dump");

  console.log("\n[2] Tapping a menu button genuinely runs the SAME handler as typing the command...");
  const statusButton = menuButtons.find((b) => b.callback_data === "menucmd:status")!;
  sentTelegramCalls.length = 0;
  await dispatchCallback(deps, { id: "cb1", data: statusButton.callback_data, message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  const tappedResult = sentTelegramCalls.find((c) => c.method === "sendMessage");
  sentTelegramCalls.length = 0;
  await dispatchCommand(deps, CHAT_ID, `${OWNER}:${CHAT_ID}`, "/status");
  const typedResult = sentTelegramCalls.find((c) => c.method === "sendMessage");
  console.log(`    tapped: "${(tappedResult!.body as { text: string }).text.split("\n")[0]}"`);
  console.log(`    typed:  "${(typedResult!.body as { text: string }).text.split("\n")[0]}"`);
  assert.equal((tappedResult!.body as { text: string }).text, (typedResult!.body as { text: string }).text, "tapping the menu button must produce IDENTICAL output to typing the command");

  console.log("\n[3] Real setMyCommands payload: every command has a real description with an emoji prefix...");
  sentTelegramCalls.length = 0;
  await registerDefaultCommandMenu(client);
  const setMyCommandsCall = sentTelegramCalls.find((c) => c.method === "setMyCommands")!;
  const registered = (setMyCommandsCall.body as { commands: { command: string; description: string }[] }).commands;
  console.log(`    ${registered.length} commands registered`);
  for (const c of registered) console.log(`    /${c.command} -> "${c.description}"`);
  assert.equal(registered.length, DAVE_COMMANDS.length);
  const emojiPattern = /\p{Extended_Pictographic}/u;
  for (const c of registered) {
    assert.ok(c.description && c.description.length > 0, `/${c.command} must have a real description`);
    assert.match(c.description, emojiPattern, `/${c.command}'s description must carry an emoji prefix`);
  }

  console.log("\n[4] ElevenLabs API key is genuinely settable from a real Telegram message (not admin-panel-only)...");
  assert.equal(getTtsProviderKey(db, OWNER, "elevenlabs"), undefined);
  await dispatchCallback(deps, { id: "cb2", data: "voice:setkey:elevenlabs", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  const consumedTts = await tryHandlePendingTtsKeyEntry(deps, CHAT_ID, "el-real-fake-key-123");
  assert.equal(consumedTts, true);
  console.log(`    getTtsProviderKey(elevenlabs) -> "${getTtsProviderKey(db, OWNER, "elevenlabs")}"`);
  assert.equal(getTtsProviderKey(db, OWNER, "elevenlabs"), "el-real-fake-key-123");

  console.log("\n[5] E2B API key is genuinely settable from a real Telegram message (not admin-panel-only)...");
  assert.equal(listE2BKeys(db, OWNER).length, 0);
  await dispatchCallback(deps, { id: "cb3", data: "e2bkey:add", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  const consumedE2B = await tryHandlePendingE2BKeyEntry(deps, CHAT_ID, "e2b_real_fake_key_456");
  assert.equal(consumedE2B, true);
  const e2bKeys = listE2BKeys(db, OWNER);
  console.log(`    real stored E2B keys: ${e2bKeys.length}, apiKey: "${e2bKeys[0]?.apiKey}"`);
  assert.equal(e2bKeys.length, 1);
  assert.equal(e2bKeys[0].apiKey, "e2b_real_fake_key_456");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}
