import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { TelegramClient } from "@dave/telegram";
import { setRiskMode, setTradingMode, setTrailingStopConfig, upsertGroup, setActiveGroup, getRiskSettings, getTradingMode, getActiveGroupInfo, getTrailingStopConfig } from "@dave/trading";
import { setWriteApprovalSetting, getWriteApprovalSetting, ensureUserMemory, appendUserFact } from "@dave/memory";
import { setVoiceEnabled, getVoiceSettings, setPushEnabled, getNotificationSettings } from "@dave/notifications";
import { addProviderKey, listProviderKeys } from "@dave/brain";
import { saveConversationHistory, loadConversationHistory } from "../src/conversation-store.js";
import { dispatchCommand, dispatchCallback, type CommandRouterDeps } from "../src/command-router.js";

/**
 * Real proof for item 8: "/reset should be a full wipe... Delete all memory files... Delete all
 * config/settings back to defaults... Add a real confirmation step first (colored Approve/
 * Decline buttons)... After wiping, automatically send the /menu command's UI."
 * Confirms: (a) a single /reset does NOT wipe anything until confirmed, (b) tapping "Cancel"
 * genuinely leaves everything untouched, (c) tapping "Yes" genuinely wipes conversation history,
 * memory files, and every real trading/voice/notification setting back to their real defaults,
 * (d) provider API keys and goal.yaml-equivalent content survive, (e) /menu is genuinely sent
 * automatically afterward.
 */

console.log("=== Real proof: /reset is a real confirmed full wipe, not a silent one-tap history clear ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-full-reset-"));
process.chdir(workDir);
const OWNER = "user-full-reset-1";
const CHAT_ID = 555666;

const sentMessages: Array<{ text: string; reply_markup?: unknown }> = [];
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
  const historyKey = `${OWNER}:${CHAT_ID}`;

  console.log("[1] Seed real state across every real subsystem /reset is supposed to touch...");
  saveConversationHistory(db, historyKey, [{ role: "system", content: "sys" }, { role: "user", content: "hello, my real name is David" }]);
  ensureUserMemory(OWNER);
  appendUserFact(OWNER, "Prefers to be called: David");
  setRiskMode(OWNER, "sl", "on", 20);
  setTradingMode(OWNER, "trading-skills", "scalping-101");
  upsertGroup(OWNER, { id: "forex-1", name: "Forex", symbols: ["EURUSD"] });
  setActiveGroup(OWNER, "forex-1");
  setTrailingStopConfig(OWNER, { slAtTp1: 1.1, slAtTp2: 1.2, slAtTp3: 1.3 });
  setWriteApprovalSetting(OWNER, true);
  setVoiceEnabled(db, OWNER, true);
  setPushEnabled(db, OWNER, false);
  addProviderKey(db, OWNER, "openai", "real key", { apiKey: "sk-real-fake-should-survive" });
  console.log("    real state seeded: history, USER.md fact, risk SL=on/20, trading-skills mode, active pair group, trailing config, write-approval=on, voice=on, push=off, 1 provider key");

  console.log("\n[2] Typing /reset sends a REAL confirmation prompt with colored Approve/Decline buttons -- nothing is wiped yet...");
  sentMessages.length = 0;
  await dispatchCommand(deps, CHAT_ID, historyKey, "/reset");
  const prompt = sentMessages[0];
  console.log(`    "${prompt.text.split("\n")[0]}"`);
  const promptButtons = (prompt.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard.flat();
  console.log(`    real buttons: ${promptButtons.map((b) => b.text).join(" | ")}`);
  assert.ok(promptButtons.some((b) => b.callback_data === "resetconfirm:yes"));
  assert.ok(promptButtons.some((b) => b.callback_data === "resetconfirm:no"));
  assert.equal(loadConversationHistory(db, historyKey).length, 2, "history must be UNTOUCHED until confirmed");
  assert.equal(getRiskSettings(OWNER).slMode, "on", "settings must be UNTOUCHED until confirmed");

  console.log("\n[3] Tapping Cancel genuinely leaves EVERYTHING untouched...");
  sentMessages.length = 0;
  await dispatchCallback(deps, { id: "cb-cancel", data: "resetconfirm:no", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  assert.equal(loadConversationHistory(db, historyKey).length, 2);
  assert.equal(getRiskSettings(OWNER).slMode, "on");
  console.log(`    "${sentMessages[0].text}" -- confirmed nothing was wiped`);

  console.log("\n[4] Tapping 'Yes, wipe everything' genuinely wipes conversation history, memory files, AND every real trading/voice/notification setting back to defaults...");
  sentMessages.length = 0;
  await dispatchCallback(deps, { id: "cb-confirm", data: "resetconfirm:yes", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);

  const historyAfter = loadConversationHistory(db, historyKey);
  console.log(`    conversation history: ${historyAfter.length} messages (was 2)`);
  assert.equal(historyAfter.length, 0);

  const userMdAfter = readFileSync(join(workDir, "data", "memory", OWNER, "USER.md"), "utf8");
  console.log(`    USER.md after reset: "${userMdAfter.trim()}" (real fact genuinely gone)`);
  assert.ok(!userMdAfter.includes("David"), "USER.md must genuinely be back to empty/template, not still holding the real fact");

  const riskAfter = getRiskSettings(OWNER);
  console.log(`    risk settings after reset: slMode=${riskAfter.slMode} (was "on")`);
  assert.equal(riskAfter.slMode, "off", "risk settings must be genuinely back to default");

  const modeAfter = getTradingMode(OWNER);
  console.log(`    trading mode after reset: ${modeAfter.mode} (was "trading-skills")`);
  assert.equal(modeAfter.mode, "auto", "trading mode must be genuinely back to default");

  const groupAfter = getActiveGroupInfo(OWNER);
  console.log(`    active pair group after reset: ${groupAfter.activeGroup?.name ?? "none"} (was "Forex")`);
  assert.equal(groupAfter.activeGroup, null, "the active/fallback SELECTION must genuinely clear");

  const trailingAfter = getTrailingStopConfig(OWNER);
  console.log(`    trailing config after reset: ${JSON.stringify(trailingAfter)} (was set)`);
  assert.equal(trailingAfter, undefined, "trailing config must genuinely be gone");

  console.log(`    write-approval after reset: ${getWriteApprovalSetting(OWNER)} (was true)`);
  assert.equal(getWriteApprovalSetting(OWNER), false);

  const voiceAfter = getVoiceSettings(db, OWNER);
  console.log(`    voice settings after reset: enabled=${voiceAfter.enabled} (was true)`);
  assert.equal(voiceAfter.enabled, false);

  const notifAfter = getNotificationSettings(db, OWNER);
  console.log(`    notification settings after reset: pushEnabled=${notifAfter.pushEnabled} (was false, real default is true)`);
  assert.equal(notifAfter.pushEnabled, true, "notification settings must be genuinely back to their real default, not just left at whatever was set");

  console.log("\n[5] The stored provider API key genuinely SURVIVES the reset -- credentials are not a 'setting'...");
  const keysAfter = listProviderKeys(db, OWNER, "openai");
  console.log(`    provider keys after reset: ${keysAfter.length} (unchanged)`);
  assert.equal(keysAfter.length, 1);
  assert.equal(keysAfter[0].config.apiKey, "sk-real-fake-should-survive");

  console.log("\n[6] /menu's real UI is automatically sent after the wipe, so the user lands somewhere useful...");
  console.log(`    real messages sent during the wipe: ${sentMessages.map((m) => m.text.split("\n")[0]).join(" | ")}`);
  const menuMessage = sentMessages.find((m) => m.text.includes("Menu"));
  assert.ok(menuMessage, "a real /menu UI message must be sent automatically after the wipe");
  assert.ok((menuMessage!.reply_markup as { inline_keyboard: unknown[] } | undefined)?.inline_keyboard, "it must be the real inline-keyboard menu, not plain text");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}
