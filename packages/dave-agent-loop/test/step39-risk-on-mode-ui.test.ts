import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { TelegramClient } from "@dave/telegram";
import { getRiskSettings } from "@dave/trading";
import { dispatchCallback, tryHandlePendingRiskEntry, type CommandRouterDeps } from "../src/command-router.js";

/**
 * Real proof for item 12 (user: "lot size settings currently only offer Auto/Off... add the
 * missing 'On' state where the user can type in their own exact lot size (matching the same
 * On/Off/Auto pattern used for SL/TP)"). Direct investigation found the button-driven cyclemode
 * toggle deliberately only ever cycles off<->auto for ALL THREE fields (its own comment: "'on'
 * mode requires the user's own exact numeric value... a button tap can't supply") -- and no real
 * text-capture flow existed to let the user actually type that value for sl, tp, OR lot. This
 * proves the new "Set X (On)" buttons genuinely prime capture, a real numeric reply genuinely
 * applies "on" mode immediately (not gated behind approval -- this is the user's OWN direct
 * settings change, not a Dave-initiated proposal), and a bogus reply is rejected honestly.
 */

console.log("=== Real proof: SL/TP/Lot 'On' mode has a real typed-entry UI path ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-risk-on-ui-"));
process.chdir(workDir);
const OWNER = "user-risk-on-ui-1";
const CHAT_ID = 445566;

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

  console.log("[1] Risk/Trading screen genuinely offers a real 'Set SL (On)' / 'Set TP (On)' / 'Set Lot (On)' tap target...\n");
  sentMessages.length = 0;
  await dispatchCallback(deps, { id: "cb0", data: "settings:risk", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  const riskButtons = sentMessages[0].reply_markup!.inline_keyboard.flat();
  console.log(`    buttons: ${riskButtons.map((b) => b.text).join(" | ")}`);
  assert.ok(riskButtons.some((b) => b.callback_data === "setrisk:sl"), "a real 'On' tap target must exist for SL");
  assert.ok(riskButtons.some((b) => b.callback_data === "setrisk:tp"), "a real 'On' tap target must exist for TP");
  assert.ok(riskButtons.some((b) => b.callback_data === "setrisk:lot"), "a real 'On' tap target must exist for Lot -- the actual item 12 ask");

  console.log("\n[2] Tapping 'Set Lot (On)' primes capture and prompts for a real number...\n");
  sentMessages.length = 0;
  await dispatchCallback(deps, { id: "cb1", data: "setrisk:lot", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  assert.match(sentMessages[0].text, /lot size/i);

  console.log("\n[3] A bogus (non-numeric) reply is honestly rejected -- lotMode stays untouched...\n");
  sentMessages.length = 0;
  const consumedBogus = await tryHandlePendingRiskEntry(deps, CHAT_ID, "not-a-number");
  assert.equal(consumedBogus, true);
  assert.match(sentMessages[0].text, /doesn't look like a real number/);
  assert.equal(getRiskSettings(OWNER).lotMode, "off", "a bogus reply must never set 'on' mode");

  console.log("\n[4] A real number reply genuinely applies 'On' mode IMMEDIATELY -- this is the user's own direct change, not gated behind approval...\n");
  await dispatchCallback(deps, { id: "cb2", data: "setrisk:lot", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  sentMessages.length = 0;
  const consumedReal = await tryHandlePendingRiskEntry(deps, CHAT_ID, "0.5");
  assert.equal(consumedReal, true);
  console.log(`    "${sentMessages[0].text}"`);
  const settings = getRiskSettings(OWNER);
  assert.equal(settings.lotMode, "on", "lotMode must genuinely be 'on' now");
  assert.equal(settings.lotValue, 0.5, "the user's own real exact lot size must genuinely be persisted");

  console.log("\n[5] Same real flow for SL...\n");
  await dispatchCallback(deps, { id: "cb3", data: "setrisk:sl", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  sentMessages.length = 0;
  await tryHandlePendingRiskEntry(deps, CHAT_ID, "25");
  const slSettings = getRiskSettings(OWNER);
  assert.equal(slSettings.slMode, "on");
  assert.equal(slSettings.slValue, 25);
  console.log(`    real SL now: ${JSON.stringify({ slMode: slSettings.slMode, slValue: slSettings.slValue })}`);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}
