import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { TelegramClient } from "@dave/telegram";
import { getRiskSettings } from "@dave/trading";
import { dispatchCommand, dispatchCallback, tryHandlePendingLimitEntry, type CommandRouterDeps } from "../src/command-router.js";

/**
 * Real proof for the spec's protected-limits UI: "Max open trades / Max daily loss: optional,
 * PROTECTED (changing needs fresh approval)". The backend (proposeProtectedLimitChange) always
 * existed and always enforced this; what was missing was any real Telegram path to actually
 * propose a value in the first place. This proves: tapping the row primes capture, a real
 * number reply genuinely queues a real approval (never applies directly), a real Approve tap
 * genuinely applies it, and a bogus (non-numeric) reply is rejected honestly instead of
 * silently doing nothing.
 */

console.log("=== Real proof: max open trades / max daily loss protected-change UI ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-limits-ui-"));
process.chdir(workDir);
const OWNER = "user-limits-ui-1";
const CHAT_ID = 111222;

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

  console.log("[1] /settings -> Risk/Trading shows max open trades / max daily loss as real, tap-to-change rows...");
  sentMessages.length = 0;
  await dispatchCallback(deps, { id: "cb0", data: "settings:risk", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  const riskButtons = sentMessages[0].reply_markup!.inline_keyboard.flat();
  console.log(`    buttons: ${riskButtons.map((b) => b.text).join(" | ")}`);
  assert.ok(riskButtons.some((b) => b.callback_data === "proposelimit:maxOpenTrades"));
  assert.ok(riskButtons.some((b) => b.callback_data === "proposelimit:maxDailyLossPct"));

  console.log("\n[2] Tapping the row primes capture and prompts for a real number...");
  sentMessages.length = 0;
  await dispatchCallback(deps, { id: "cb1", data: "proposelimit:maxOpenTrades", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  assert.match(sentMessages[0].text, /Reply with the new max open trades/);

  console.log("\n[3] A bogus (non-numeric) reply is honestly rejected, NOT silently ignored or applied...");
  sentMessages.length = 0;
  const consumedBogus = await tryHandlePendingLimitEntry(deps, CHAT_ID, "banana");
  assert.equal(consumedBogus, true);
  assert.match(sentMessages[0].text, /doesn't look like a real number/);
  assert.equal(getRiskSettings(OWNER).maxOpenTrades, undefined, "a bogus reply must never set the real limit");

  console.log("\n[4] A real number reply genuinely queues an approval -- it does NOT apply directly...");
  await dispatchCallback(deps, { id: "cb2", data: "proposelimit:maxOpenTrades", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  sentMessages.length = 0;
  const consumedReal = await tryHandlePendingLimitEntry(deps, CHAT_ID, "5");
  assert.equal(consumedReal, true);
  console.log(`    "${sentMessages[0].text}"`);
  assert.match(sentMessages[0].text, /Approval needed/);
  assert.equal(getRiskSettings(OWNER).maxOpenTrades, undefined, "must genuinely still be unset while pending -- protected limits never apply without explicit approval");
  const approveButton = sentMessages[0].reply_markup!.inline_keyboard.flat().find((b) => b.text.includes("Approve"))!;
  assert.ok(approveButton, "a real colored Approve button must be attached");

  console.log("\n[5] Tapping the real Approve button genuinely applies it now...");
  sentMessages.length = 0;
  await dispatchCallback(deps, { id: "cb3", data: approveButton.callback_data, message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  console.log(`    "${sentMessages[0].text}"`);
  assert.equal(getRiskSettings(OWNER).maxOpenTrades, 5, "the real limit must now genuinely be set, only after explicit approval");
  assert.match(sentMessages[0].text, /MaxOpenTrades=5/);

  console.log("\n[6] The Risk/Trading screen now shows the real applied value, no longer 'pending approval'...");
  sentMessages.length = 0;
  await dispatchCommand(deps, CHAT_ID, `${OWNER}:${CHAT_ID}`, "/settings");
  await dispatchCallback(deps, { id: "cb4", data: "settings:risk", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  const finalButtons = sentMessages[sentMessages.length - 1].reply_markup!.inline_keyboard.flat();
  const maxOpenTradesButton = finalButtons.find((b) => b.callback_data === "proposelimit:maxOpenTrades")!;
  console.log(`    "${maxOpenTradesButton.text}"`);
  assert.match(maxOpenTradesButton.text, /Max open trades: 5/);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}
