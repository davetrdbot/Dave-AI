import assert from "node:assert/strict";
import { TelegramClient, getActiveIndicator, setActiveIndicator, ThinkingIndicator } from "@dave/telegram";
import { ensureNoOrphanedIndicator } from "../src/telegram-bot-server.js";

console.log("=== Step 111 real proof (updated for the third reversal -- the automatic wrapper, not a ===");
console.log("=== model-callable tool, now owns the indicator): one left registered mid-turn but never ===");
console.log("=== finalized (e.g. an exception before withThinkingIndicator's own finalize runs) is ===");
console.log("=== cleaned up by the safety net, never orphaned ===\n");

console.log("[1] The automatic wrapper registers a real indicator, then the turn 'crashes' before it's ever finalized...\n");
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

// fallbackMessage: this test's subject is a real progress MESSAGE left stuck in the chat, which
// only exists on the fallback path (off by default since step153 -- it was the trader's
// duplicate-message bug). Switched on so the scenario is genuinely reproduced; the draft-only
// default is covered as its own case at the end of this file, where there is no message to get
// stuck because an ephemeral draft fades on its own.
const indicator = new ThinkingIndicator(fakeClient, chatId, "typing", { fallbackMessage: true });
await indicator.start();
await indicator.update("trade", "Placing the trade...");
setActiveIndicator(chatId, indicator);
assert.ok(getActiveIndicator(chatId), "the automatic wrapper must have left a real, tracked indicator behind");

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

// --- The draft-only default (step153): nothing can get stuck, but tracking must still clear ---
console.log("[3] Draft-only default: no message to delete, yet the orphan is still cleared...\n");
const draftChatId = 777333;
const draftCalls: { method: string; body: Record<string, unknown> }[] = [];
const draftClient = {
  sendChatAction: async () => true,
  sendRichMessageDraft: async (body: Record<string, unknown>) => {
    draftCalls.push({ method: "sendRichMessageDraft", body });
    return true;
  },
  sendMessage: async (body: Record<string, unknown>) => {
    draftCalls.push({ method: "sendMessage", body });
    return { message_id: 1234 };
  },
  editMessageText: async () => ({ message_id: 1234 }),
  deleteMessage: async (body: Record<string, unknown>) => {
    draftCalls.push({ method: "deleteMessage", body });
    return true;
  },
} as unknown as TelegramClient;

const draftIndicator = new ThinkingIndicator(draftClient, draftChatId, "typing", { fallbackMessage: false });
await draftIndicator.start();
await draftIndicator.update("code", "running a script");
setActiveIndicator(draftChatId, draftIndicator);

const cleanedUp3 = await ensureNoOrphanedIndicator(draftClient, draftChatId);
assert.equal(cleanedUp3, true, "the orphan is still detected and reported");
assert.equal(getActiveIndicator(draftChatId), undefined, "tracking is cleared either way");
// The key difference, and the whole reason the duplicate is gone: there was never a real message,
// so there is nothing to delete -- the draft expires by itself.
assert.equal(draftCalls.filter((c) => c.method === "deleteMessage").length, 0, "nothing to delete on the draft-only path");
assert.ok(draftCalls.some((c) => c.method === "sendRichMessageDraft"), "the indicator did run as a draft");
assert.ok(
  draftCalls.some((c) => c.method === "sendMessage" && String(c.body.text).length > 0),
  "the honest fallback message still reaches the user -- silence would be the real failure"
);
console.log("    confirmed: no stuck message exists to delete, tracking cleared, user still told something\n");

console.log("=== ALL ASSERTIONS PASSED ===");
