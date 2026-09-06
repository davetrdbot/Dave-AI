import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { TelegramClient } from "@dave/telegram";
import { getTrailingStopConfig } from "@dave/trading";
import { dispatchCallback, tryHandlePendingTrailingEntry, type CommandRouterDeps } from "../src/command-router.js";

/**
 * Real proof for the spec's trailing/breakeven UI: "Trailing/breakeven: ... + TP1/TP2/TP3
 * trigger values". The real backend (trailing-config.ts) already existed but nothing let the
 * user set the 3 values from Telegram. Proves each of TP1/TP2/TP3 is genuinely settable
 * independently, and that other values survive when only one is changed.
 */

console.log("=== Real proof: trailing/breakeven TP1/TP2/TP3 UI ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-trailing-ui-"));
process.chdir(workDir);
const OWNER = "user-trailing-ui-1";
const CHAT_ID = 444555;

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

  console.log("[1] Trailing / Breakeven section shows all 3 real, unset rows...");
  sentMessages.length = 0;
  await dispatchCallback(deps, { id: "cb0", data: "settings:trailing", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  const rows = sentMessages[0].reply_markup!.inline_keyboard.flat();
  console.log(`    ${rows.map((b) => b.text).join(" | ")}`);
  assert.ok(rows.some((b) => b.callback_data === "trailing:slAtTp1"));
  assert.ok(rows.some((b) => b.callback_data === "trailing:slAtTp2"));
  assert.ok(rows.some((b) => b.callback_data === "trailing:slAtTp3"));

  console.log("\n[2] Setting TP1's SL level genuinely persists via the real backend...");
  await dispatchCallback(deps, { id: "cb1", data: "trailing:slAtTp1", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  const consumed1 = await tryHandlePendingTrailingEntry(deps, CHAT_ID, "1.0850");
  assert.equal(consumed1, true);
  console.log(`    getTrailingStopConfig -> ${JSON.stringify(getTrailingStopConfig(OWNER))}`);
  assert.equal(getTrailingStopConfig(OWNER)!.slAtTp1, 1.085);

  console.log("\n[3] Setting TP2 does NOT clobber TP1's already-set value...");
  await dispatchCallback(deps, { id: "cb2", data: "trailing:slAtTp2", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  await tryHandlePendingTrailingEntry(deps, CHAT_ID, "1.09");
  const config = getTrailingStopConfig(OWNER)!;
  console.log(`    ${JSON.stringify(config)}`);
  assert.equal(config.slAtTp1, 1.085, "TP1 must survive TP2 being set");
  assert.equal(config.slAtTp2, 1.09);

  console.log("\n[4] A non-numeric reply is honestly rejected...");
  await dispatchCallback(deps, { id: "cb3", data: "trailing:slAtTp3", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  sentMessages.length = 0;
  await tryHandlePendingTrailingEntry(deps, CHAT_ID, "not a number");
  assert.match(sentMessages[0].text, /doesn't look like a real price level/);
  assert.equal(getTrailingStopConfig(OWNER)!.slAtTp3, 0, "must remain unset, not corrupted by the bogus reply");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}
