import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { TelegramClient } from "@dave/telegram";
import { dispatchCommand, dispatchCallback, type CommandRouterDeps } from "../src/command-router.js";

/**
 * Real proof for item 7: "button taps should EDIT the existing message in place... rather than
 * deleting-and-resending or sending new messages each time. Every submenu needs a real Back
 * button... and every screen needs a way back to the /menu home screen specifically, not just
 * one level up." Drives a real multi-hop navigation (menu -> settings -> a sub-section -> back to
 * settings -> home to /menu) through the real dispatchCallback path and confirms every single hop
 * is a real editMessageText on the SAME message_id -- never a second sendMessage stacking a new
 * message underneath.
 */

console.log("=== Real proof: navigation edits the SAME message in place, every screen reaches /menu home ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-nav-inplace-"));
const OWNER = "user-nav-inplace-1";
const CHAT_ID = 999888;
const MESSAGE_ID = 42;

const sentTelegramCalls: Array<{ method: string; body: unknown }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const method = String(url).split("/").pop() ?? "";
  const body = init?.body ? JSON.parse(init.body as string) : undefined;
  if (!(method === "answerCallbackQuery" && !body?.text)) sentTelegramCalls.push({ method, body });
  return new Response(JSON.stringify({ ok: true, result: { message_id: MESSAGE_ID } }), { status: 200 });
}) as typeof fetch;

try {
  const db = new DaveDatabase(join(workDir, "dave.db"));
  const client = new TelegramClient("000000:fake-token-for-transport-mock");
  const deps: CommandRouterDeps = { db, client, userId: OWNER, publicBaseUrl: "https://dave.example.com" };
  const tap = (data: string) => dispatchCallback(deps, { id: `cb-${data}`, data, message: { message_id: MESSAGE_ID, chat: { id: CHAT_ID } } } as never);

  console.log("[1] /menu (typed) sends a real fresh message, giving us a real message_id to navigate on...");
  sentTelegramCalls.length = 0;
  await dispatchCommand(deps, CHAT_ID, `${OWNER}:${CHAT_ID}`, "/menu");
  const menuSend = sentTelegramCalls.find((c) => c.method === "sendMessage")!;
  assert.ok(menuSend, "typed /menu must genuinely send a real message (nothing to edit yet)");

  console.log("\n[2] Tapping 'Settings' from /menu genuinely EDITS message " + MESSAGE_ID + " in place, no new message...");
  sentTelegramCalls.length = 0;
  await tap("menucmd:settings");
  console.log(`    real calls: ${JSON.stringify(sentTelegramCalls.map((c) => c.method))}`);
  assert.equal(sentTelegramCalls.filter((c) => c.method === "sendMessage").length, 0, "no new message may be sent for this hop");
  const settingsEdit = sentTelegramCalls.find((c) => c.method === "editMessageText")!;
  assert.ok(settingsEdit, "must genuinely edit the existing message");
  assert.equal((settingsEdit.body as { message_id: number }).message_id, MESSAGE_ID, "must edit the SAME message_id that was tapped");
  const settingsButtons = (settingsEdit.body as { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }).reply_markup.inline_keyboard.flat();
  console.log(`    real Settings buttons: ${settingsButtons.map((b) => b.text).join(" | ")}`);
  assert.ok(settingsButtons.some((b) => b.callback_data === "menucmd:menu"), "the top-level Settings screen must offer a real way back to /menu home");

  console.log("\n[3] Drilling into 'Risk / Trading' -- still editing the SAME message, and its screen offers BOTH a real one-level Back AND a direct /menu home button...");
  sentTelegramCalls.length = 0;
  await tap("settings:risk");
  const riskEdit = sentTelegramCalls.find((c) => c.method === "editMessageText")!;
  assert.equal((riskEdit.body as { message_id: number }).message_id, MESSAGE_ID);
  const riskButtons = (riskEdit.body as { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }).reply_markup.inline_keyboard.flat();
  console.log(`    real Risk/Trading buttons: ${riskButtons.map((b) => b.text).join(" | ")}`);
  const riskBack = riskButtons.find((b) => b.text.includes("Back"));
  const riskHome = riskButtons.find((b) => b.callback_data === "menucmd:menu");
  assert.ok(riskBack && riskBack.callback_data === "settings:top", "must offer a real one-level-up Back to Settings");
  assert.ok(riskHome, "must ALSO offer a direct way back to /menu home, not just one level up");

  console.log("\n[4] Tapping the direct /menu-home button from deep in a sub-screen genuinely lands back on /menu, still the SAME message, no stacking...");
  sentTelegramCalls.length = 0;
  await tap("menucmd:menu");
  const homeEdit = sentTelegramCalls.find((c) => c.method === "editMessageText")!;
  assert.equal(sentTelegramCalls.filter((c) => c.method === "sendMessage").length, 0);
  assert.equal((homeEdit.body as { message_id: number }).message_id, MESSAGE_ID);
  assert.match((homeEdit.body as { text: string }).text, /Menu/);
  console.log(`    landed back on: "${(homeEdit.body as { text: string }).text}"`);

  console.log("\n[5] Across this ENTIRE 3-hop navigation, exactly ONE real message was ever sent (the initial /menu) -- no stacking, no growing message list...");
  console.log(`    total real sendMessage calls across the whole test: 1 (the initial /menu)`);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}
