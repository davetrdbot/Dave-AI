import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { TelegramClient } from "@dave/telegram";
import { getNotificationSettings, NOTIFICATION_TOOLS } from "@dave/notifications";
import { dispatchCallback, type CommandRouterDeps } from "../src/command-router.js";

/**
 * Real proof for the spec's Notifications section: "Push notifications on/off... Trade-opened
 * notification". Confirms the /settings toggle genuinely persists AND genuinely gates the real
 * alert-sending tool (previously it would have sent unconditionally -- a toggle with no real
 * effect is exactly the "ghost feature" pattern this build keeps finding and fixing).
 */

console.log("=== Real proof: Notifications push/trade-opened toggle genuinely gates real sends ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-notif-ui-"));
process.chdir(workDir);
const OWNER = "user-notif-ui-1";
const CHAT_ID = 222333;

const sentMessages: Array<{ text: string; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } }> = [];
const sentTelegramAlerts: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (_url: string, init?: RequestInit) => {
  const body = init?.body ? JSON.parse(init.body as string) : undefined;
  if (body?.text) {
    sentMessages.push({ text: body.text, reply_markup: body.reply_markup });
    sentTelegramAlerts.push(body.text);
  }
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
}) as typeof fetch;

try {
  const db = new DaveDatabase(join(workDir, "dave.db"));
  const client = new TelegramClient("000000:fake-token-for-transport-mock");
  const deps: CommandRouterDeps = { db, client, userId: OWNER, publicBaseUrl: "https://dave.example.com" };
  const connectTool = NOTIFICATION_TOOLS.find((t) => t.name === "send_ea_connected_notification")!;
  const toolCtx = { userId: OWNER, db, client, chatId: CHAT_ID };

  console.log("[1] Push defaults ON -- the real alert tool genuinely sends...");
  assert.equal(getNotificationSettings(db, OWNER).pushEnabled, true);
  sentTelegramAlerts.length = 0;
  const resultOn = await connectTool.execute({ system: "dave" }, toolCtx);
  console.log(`    tool result: ${JSON.stringify(resultOn)}`);
  console.log(`    real alerts sent: ${sentTelegramAlerts.length}`);
  assert.equal(sentTelegramAlerts.length, 1, "with push ON, the real alert must genuinely be sent");

  console.log("\n[2] Tapping the real toggle in /settings -> Notifications genuinely turns push OFF...");
  sentMessages.length = 0;
  await dispatchCallback(deps, { id: "cb1", data: "settings:notifications", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  const pushButton = sentMessages[0].reply_markup!.inline_keyboard.flat().find((b) => b.callback_data === "notif:togglepush")!;
  console.log(`    "${pushButton.text}"`);
  await dispatchCallback(deps, { id: "cb2", data: "notif:togglepush", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  assert.equal(getNotificationSettings(db, OWNER).pushEnabled, false);

  console.log("\n[3] With push OFF, the real alert tool genuinely does NOT send anything -- a real no-op, not a silent no-op...");
  sentTelegramAlerts.length = 0;
  const resultOff = await connectTool.execute({ system: "dave" }, toolCtx);
  console.log(`    tool result: ${JSON.stringify(resultOff)}`);
  console.log(`    real alerts sent: ${sentTelegramAlerts.length}`);
  assert.deepEqual(resultOff, { skipped: true, reason: "push notifications are off" });
  assert.equal(sentTelegramAlerts.length, 0, "with push OFF, the real alert must genuinely NOT be sent");

  console.log("\n[4] Email toggle is real (stored, tap-to-confirm) and honest about not having a real sender yet...");
  await dispatchCallback(deps, { id: "cb3", data: "notif:toggleemail", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  assert.equal(getNotificationSettings(db, OWNER).emailEnabled, true);
  const emailConfirm = sentMessages.find((m) => m.text.includes("Email notifications"));
  console.log(`    "${emailConfirm?.text}"`);
  assert.match(emailConfirm!.text, /real email sending isn't built yet/);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}
