import assert from "node:assert/strict";
import { TelegramClient, TELEGRAM_TOOLS, getActiveIndicator } from "@dave/telegram";
import { ensureNoOrphanedIndicator } from "../src/telegram-bot-server.js";

console.log("=== Step 111 real proof: an indicator opened by tg_thinking but never finalized ===");
console.log("=== (e.g. an exception mid-turn) is cleaned up by the safety net, never orphaned ===\n");

function findTool(name: string) {
  const tool = TELEGRAM_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} missing`);
  return tool;
}

console.log("[1] tg_thinking opens a real indicator, then the turn 'crashes' before tg_finalize is ever called...\n");
const calls: { method: string; body: Record<string, unknown> }[] = [];
const chatId = 424242;
const fakeClient = {
  sendChatAction: async (body: Record<string, unknown>) => {
    calls.push({ method: "sendChatAction", body });
    return true;
  },
  sendRichMessageDraft: async () => true,
  sendMessage: async (body: Record<string, unknown>) => {
    calls.push({ method: "sendMessage", body });
    return { message_id: 909 };
  },
  editMessageText: async (body: Record<string, unknown>) => {
    calls.push({ method: "editMessageText", body });
    return { message_id: 909 };
  },
  deleteMessage: async (body: Record<string, unknown>) => {
    calls.push({ method: "deleteMessage", body });
    return true;
  },
} as unknown as TelegramClient;

await findTool("tg_thinking").execute({ text: "Placing the trade..." }, { client: fakeClient, chatId });
assert.ok(getActiveIndicator(chatId), "tg_thinking must have left a real, tracked indicator behind");

// Simulate exactly what runAgentTurn's `finally` block does on any exit path (success, abort, or
// -- the real case this closes -- a hard exception mid-turn that never reached tg_finalize).
const cleanedUp = await ensureNoOrphanedIndicator(fakeClient, chatId);

console.log(`    ensureNoOrphanedIndicator found and cleaned up an orphan: ${cleanedUp}`);
assert.equal(cleanedUp, true, "a real orphaned indicator must be detected and cleaned up");
assert.equal(getActiveIndicator(chatId), undefined, "the indicator must no longer be tracked after the safety net runs");
assert.ok(calls.some((c) => c.method === "deleteMessage"), "the stuck 'thinking...' message must genuinely be deleted/replaced, never left stuck");
assert.ok(
  calls[calls.length - 1].method === "sendMessage" && String(calls[calls.length - 1].body.text).length > 0,
  "a real, honest fallback message must replace the orphaned indicator, not silence"
);
console.log(`    real calls: ${calls.map((c) => c.method).join(" -> ")}`);
console.log("    confirmed: no orphaned 'thinking...' message survives an unfinalized turn\n");

console.log("[2] Calling the safety net when there was never an indicator at all is a real, safe no-op...\n");
const idleChatId = 555555;
const idleCalls: { method: string }[] = [];
const idleClient = {
  sendChatAction: async () => true,
  sendRichMessageDraft: async () => true,
  sendMessage: async (body: Record<string, unknown>) => {
    idleCalls.push({ method: "sendMessage" });
    return { message_id: 1 };
  },
  editMessageText: async () => {
    idleCalls.push({ method: "editMessageText" });
    return { message_id: 1 };
  },
  deleteMessage: async () => {
    idleCalls.push({ method: "deleteMessage" });
    return true;
  },
} as unknown as TelegramClient;
const cleanedUp2 = await ensureNoOrphanedIndicator(idleClient, idleChatId);
assert.equal(cleanedUp2, false, "no indicator ever existed for this chat -- must report nothing to clean up");
assert.equal(idleCalls.length, 0, "must not touch Telegram at all when there was never an indicator");
console.log("    confirmed: a normal plain-message turn (no tg_thinking ever called) is left completely untouched\n");

console.log("=== ALL ASSERTIONS PASSED ===");
