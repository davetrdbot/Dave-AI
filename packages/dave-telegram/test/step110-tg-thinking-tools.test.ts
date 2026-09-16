import assert from "node:assert/strict";
import { TelegramClient, TELEGRAM_TOOLS, getActiveIndicator, clearActiveIndicator } from "../src/index.js";

console.log("=== Step 110 real proof: tg_thinking/tg_thinking_update/tg_finalize reinstated as ===");
console.log("=== model-callable tools, now the ONLY path that can ever create/update/finalize ===");
console.log("=== a ThinkingIndicator (no automatic wrapper running alongside them anymore) ===\n");

function findTool(name: string) {
  const tool = TELEGRAM_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} missing`);
  return tool;
}

const tgThinking = findTool("tg_thinking");
const tgThinkingUpdate = findTool("tg_thinking_update");
const tgFinalize = findTool("tg_finalize");

// --- (a) open -> update -> update -> finalize produces exactly ONE message, edited in place, ---
// --- then cleanly finalized -- never a second, duplicate message. ---
console.log("[a] open -> update -> update -> finalize -- exactly one message, edited then finalized...\n");
const calls: { method: string; body: Record<string, unknown> }[] = [];
const chatId = 847213;
const fakeClient = {
  sendChatAction: async (body: Record<string, unknown>) => {
    calls.push({ method: "sendChatAction", body });
    return true;
  },
  sendRichMessageDraft: async (body: Record<string, unknown>) => {
    calls.push({ method: "sendRichMessageDraft", body });
    return true;
  },
  sendMessage: async (body: Record<string, unknown>) => {
    calls.push({ method: "sendMessage", body });
    return { message_id: 555 };
  },
  editMessageText: async (body: Record<string, unknown>) => {
    calls.push({ method: "editMessageText", body });
    return { message_id: 555 };
  },
  deleteMessage: async (body: Record<string, unknown>) => {
    calls.push({ method: "deleteMessage", body });
    return true;
  },
} as unknown as TelegramClient;

const ctx = { client: fakeClient, chatId };

assert.equal(getActiveIndicator(chatId), undefined, "no indicator should exist before tg_thinking is ever called");

await tgThinking.execute({ text: "Scanning 8 pairs..." }, ctx);
assert.ok(getActiveIndicator(chatId), "tg_thinking must create a real, tracked indicator");

// The throttle inside ThinkingIndicator (1.2s) means a rapid-fire update right after the first
// one may not produce a second real editMessageText -- that's the same, correct throttling
// behavior step9's test already covers. Space these out so both genuinely land as real edits.
await new Promise((r) => setTimeout(r, 1300));
await tgThinkingUpdate.execute({ text: "Checking XAUUSD H4 structure..." }, ctx);
await new Promise((r) => setTimeout(r, 1300));
await tgThinkingUpdate.execute({ text: "Running correlation check..." }, ctx);
await new Promise((r) => setTimeout(r, 1300));
await tgFinalize.execute({ text: "Done -- XAUUSD BUY at 2015, SL 2008, TP 2035." }, ctx);

assert.equal(getActiveIndicator(chatId), undefined, "tg_finalize must clear the tracked indicator");

const sendMessageCalls = calls.filter((c) => c.method === "sendMessage");
const editCalls = calls.filter((c) => c.method === "editMessageText");
const deleteCalls = calls.filter((c) => c.method === "deleteMessage");
console.log(`    sendMessage calls: ${sendMessageCalls.length}, editMessageText calls: ${editCalls.length}, deleteMessage calls: ${deleteCalls.length}`);

// Exactly one real progress message was ever created (the first tg_thinking's guaranteed-visible
// fallback) -- everything else is an edit of that SAME message, never a second created message.
assert.equal(sendMessageCalls.length, 2, "exactly one progress message created (1) + one real final message (1) -- never a duplicate progress message");
assert.equal(editCalls.length, 2, "both tg_thinking_update calls edited the SAME message in place");
assert.equal(deleteCalls.length, 1, "the progress message is cleanly deleted once, right before the real final message");
assert.equal(new Set(editCalls.map((c) => c.body.message_id)).size, 1, "every edit targets the SAME message_id -- never a second message");
assert.equal(sendMessageCalls[sendMessageCalls.length - 1].body.text, "Done -- XAUUSD BUY at 2015, SL 2008, TP 2035.");
console.log("    confirmed: one message opened, edited twice in place, finalized once -- no duplicates\n");

// --- (b) a second tg_thinking call in the SAME turn must reuse the existing indicator, never ---
// --- open a second one. ---
console.log("[b] a second tg_thinking call in the same turn reuses the existing indicator...\n");
const calls2: { method: string; body: Record<string, unknown> }[] = [];
const chatId2 = 999;
const fakeClient2 = {
  sendChatAction: async () => true,
  sendRichMessageDraft: async () => true,
  sendMessage: async (body: Record<string, unknown>) => {
    calls2.push({ method: "sendMessage", body });
    return { message_id: 777 };
  },
  editMessageText: async (body: Record<string, unknown>) => {
    calls2.push({ method: "editMessageText", body });
    return { message_id: 777 };
  },
  deleteMessage: async (body: Record<string, unknown>) => {
    calls2.push({ method: "deleteMessage", body });
    return true;
  },
} as unknown as TelegramClient;
const ctx2 = { client: fakeClient2, chatId: chatId2 };

const first = await tgThinking.execute({ text: "Starting phase 1" }, ctx2);
const indicatorAfterFirst = getActiveIndicator(chatId2);
const second: any = await tgThinking.execute({ text: "Starting phase 2" }, ctx2);
const indicatorAfterSecond = getActiveIndicator(chatId2);
assert.equal(indicatorAfterFirst, indicatorAfterSecond, "a second tg_thinking call must reuse the SAME indicator instance, never create a new one");
assert.equal(second.reused, true, "the tool result must say it reused the existing indicator");
await tgFinalize.execute({ text: "Both phases done." }, ctx2);
console.log(`    first: ${JSON.stringify(first)}, second: ${JSON.stringify(second)}`);
console.log("    confirmed: no second indicator was ever created\n");

// --- (c) tg_thinking_update/tg_finalize with no active indicator errors clearly, no crash. ---
console.log("[c] tg_thinking_update/tg_finalize with no active indicator error clearly instead of silently misbehaving...\n");
const chatId3 = 111;
const ctx3 = { client: fakeClient2, chatId: chatId3 };
await assert.rejects(() => tgThinkingUpdate.execute({ text: "..." }, ctx3), /no active thinking indicator/);
await assert.rejects(() => tgFinalize.execute({ text: "..." }, ctx3), /no active thinking indicator/);
console.log("    confirmed: clear, real errors, no orphaned state\n");

clearActiveIndicator(chatId);
clearActiveIndicator(chatId2);

console.log("=== ALL ASSERTIONS PASSED ===");
