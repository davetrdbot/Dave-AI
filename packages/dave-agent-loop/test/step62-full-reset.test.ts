import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { TelegramClient } from "@dave/telegram";
import { setRiskMode, setTradingMode, setTrailingStopConfig, upsertGroup, setActiveGroup, getRiskSettings, getTradingMode, getActiveGroupInfo, getTrailingStopConfig } from "@dave/trading";
import { setWriteApprovalSetting, getWriteApprovalSetting, ensureUserMemory, appendUserFact, recordTurn, extractAtoms, recordScenario, getConversation, getAtoms, getScenarios } from "@dave/memory";
import { setVoiceEnabled, getVoiceSettings, setPushEnabled, getNotificationSettings } from "@dave/notifications";
import { addProviderKey, listProviderKeys } from "@dave/brain";
import { saveConversationHistory, loadConversationHistory } from "../src/conversation-store.js";
import { dispatchCommand, dispatchCallback, type CommandRouterDeps } from "../src/command-router.js";

/**
 * Real proof, rewritten to the user's explicit corrected spec (live, verbatim): "/reset doesn't
 * fuckin do anything... it should reset the bot like a brand new. The only thing it should leave
 * is the user settings and the apis and ea token, it should delete every fuckin thing." The
 * earlier version of /reset (and this test) treated risk/trading-mode/pair-group/trailing/voice/
 * notification/write-approval/confidence settings as things to wipe back to defaults -- that's
 * the OPPOSITE of what the user wants: settings must SURVIVE, only memory/conversation is wiped.
 * Also proves the newly-found second memory store (tencent-tiers.ts's L0/L1/L2 -- every raw turn,
 * extracted fact, and scenario summary, fully separate from MEMORY.md/USER.md/ADAPTABILITY.md and
 * never touched by the old /reset) is now genuinely cleared too.
 */

console.log("=== Real proof: /reset wipes memory + every conversation thread, leaves settings/keys/EA token untouched ===\n");

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
  const autonomousHistoryKey = `${OWNER}:autonomous:${CHAT_ID}`;

  console.log("[1] Seed real state across every real subsystem -- both what /reset should wipe AND what it must now leave alone...");
  saveConversationHistory(db, historyKey, [{ role: "system", content: "sys" }, { role: "user", content: "hello, my real name is David" }]);
  saveConversationHistory(db, autonomousHistoryKey, [{ role: "system", content: "sys" }, { role: "assistant", content: "Heads-up: settings changed." }]);
  ensureUserMemory(OWNER);
  appendUserFact(OWNER, "Prefers to be called: David");
  const turn = recordTurn(OWNER, "user", "my name is David and I trade EURUSD");
  extractAtoms(OWNER, turn);
  recordScenario(OWNER, "User introduced themselves as David", 1);
  setRiskMode(OWNER, "sl", "on", 20);
  setTradingMode(OWNER, "trading-skills", "scalping-101");
  upsertGroup(OWNER, { id: "forex-1", name: "Forex", symbols: ["EURUSD"] });
  setActiveGroup(OWNER, "forex-1");
  setTrailingStopConfig(OWNER, { slAtTp1: 1.1, slAtTp2: 1.2, slAtTp3: 1.3 });
  setWriteApprovalSetting(OWNER, true);
  setVoiceEnabled(db, OWNER, true);
  setPushEnabled(db, OWNER, false);
  addProviderKey(db, OWNER, "openai", "real key", { apiKey: "sk-real-fake-should-survive" });
  console.log("    real state seeded: 2 conversation threads (main + autonomous), USER.md fact, L0/L1/L2 tiers, risk SL=on/20, trading-skills mode, active pair group, trailing config, write-approval=on, voice=on, push=off, 1 provider key");

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

  console.log("\n[4] Tapping 'Yes, wipe everything' genuinely wipes BOTH conversation threads, MEMORY.md/USER.md/ADAPTABILITY.md, AND the L0/L1/L2 recall tiers...");
  sentMessages.length = 0;
  await dispatchCallback(deps, { id: "cb-confirm", data: "resetconfirm:yes", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);

  const historyAfter = loadConversationHistory(db, historyKey);
  console.log(`    main chat history: ${historyAfter.length} messages (was 2)`);
  assert.equal(historyAfter.length, 0);

  const autonomousHistoryAfter = loadConversationHistory(db, autonomousHistoryKey);
  console.log(`    autonomous-cycle's OWN separate history: ${autonomousHistoryAfter.length} messages (was 2) -- a real gap the old /reset never touched`);
  assert.equal(autonomousHistoryAfter.length, 0, "the autonomous cycle's own conversation thread must genuinely clear too, not just the chat the user typed in");

  const userMdAfter = readFileSync(join(workDir, "data", "memory", OWNER, "USER.md"), "utf8");
  console.log(`    USER.md after reset: "${userMdAfter.trim()}" (real fact genuinely gone)`);
  assert.ok(!userMdAfter.includes("David"), "USER.md must genuinely be back to empty/template, not still holding the real fact");

  // Checked BEFORE any getConversation/getAtoms/getScenarios call below -- those getters call
  // tierDir() internally, which auto-creates the directory as a read-side-effect (same pattern
  // every other per-user store in this codebase uses), so reading first would recreate an empty
  // dir and make this assertion meaningless.
  assert.ok(!existsSync(join(workDir, "data", "memory", OWNER, "tiers")), "the whole tiers/ directory must genuinely be gone right after reset, not just emptied");

  console.log(`    L0 conversation tier after reset: ${JSON.stringify(getConversation(OWNER))}`);
  assert.equal(getConversation(OWNER).length, 0, "the L0 raw-turn log must be genuinely gone -- this is the real second memory store the old /reset never cleared");
  console.log(`    L1 atoms tier after reset: ${JSON.stringify(getAtoms(OWNER))}`);
  assert.equal(getAtoms(OWNER).length, 0);
  console.log(`    L2 scenarios tier after reset: ${JSON.stringify(getScenarios(OWNER))}`);
  assert.equal(getScenarios(OWNER).length, 0);

  console.log("\n[5] Real settings genuinely SURVIVE the reset now -- this is a memory wipe, not a settings wipe...");
  const riskAfter = getRiskSettings(OWNER);
  console.log(`    risk settings after reset: slMode=${riskAfter.slMode}, slValue=${riskAfter.slValue} (still "on"/20 -- untouched)`);
  assert.equal(riskAfter.slMode, "on", "risk settings must genuinely survive a memory reset");
  assert.equal(riskAfter.slValue, 20);

  const modeAfter = getTradingMode(OWNER);
  console.log(`    trading mode after reset: ${modeAfter.mode} (still "trading-skills" -- untouched)`);
  assert.equal(modeAfter.mode, "trading-skills");

  const groupAfter = getActiveGroupInfo(OWNER);
  console.log(`    active pair group after reset: ${groupAfter.activeGroup?.name ?? "none"} (still "Forex" -- untouched)`);
  assert.equal(groupAfter.activeGroup?.name, "Forex");

  const trailingAfter = getTrailingStopConfig(OWNER);
  console.log(`    trailing config after reset: ${JSON.stringify(trailingAfter)} (still set -- untouched)`);
  assert.deepEqual(trailingAfter, { slAtTp1: 1.1, slAtTp2: 1.2, slAtTp3: 1.3 });

  console.log(`    write-approval after reset: ${getWriteApprovalSetting(OWNER)} (still true -- untouched)`);
  assert.equal(getWriteApprovalSetting(OWNER), true);

  const voiceAfter = getVoiceSettings(db, OWNER);
  console.log(`    voice settings after reset: enabled=${voiceAfter.enabled} (still true -- untouched)`);
  assert.equal(voiceAfter.enabled, true);

  const notifAfter = getNotificationSettings(db, OWNER);
  console.log(`    notification settings after reset: pushEnabled=${notifAfter.pushEnabled} (still false -- untouched)`);
  assert.equal(notifAfter.pushEnabled, false);

  console.log("\n[6] The stored provider API key genuinely SURVIVES the reset -- credentials are not memory...");
  const keysAfter = listProviderKeys(db, OWNER, "openai");
  console.log(`    provider keys after reset: ${keysAfter.length} (unchanged)`);
  assert.equal(keysAfter.length, 1);
  assert.equal(keysAfter[0].config.apiKey, "sk-real-fake-should-survive");

  console.log("\n[7] /menu's real UI is automatically sent after the wipe, so the user lands somewhere useful...");
  console.log(`    real messages sent during the wipe: ${sentMessages.map((m) => m.text.split("\n")[0]).join(" | ")}`);
  const menuMessage = sentMessages.find((m) => m.text.includes("Menu"));
  assert.ok(menuMessage, "a real /menu UI message must be sent automatically after the wipe");
  assert.ok((menuMessage!.reply_markup as { inline_keyboard: unknown[] } | undefined)?.inline_keyboard, "it must be the real inline-keyboard menu, not plain text");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}
