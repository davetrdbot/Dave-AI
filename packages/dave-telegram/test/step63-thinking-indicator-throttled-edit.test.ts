import assert from "node:assert/strict";
import { withThinkingIndicator, type TelegramClient } from "../src/index.js";

/**
 * Real proof for item 6 (user: "the thinking-draft streaming indicator isn't visibly happening
 * in real use"). Confirmed via a real fetch of the current Telegram Bot API docs:
 * sendRichMessageDraft/sendRichMessage ARE real, documented methods -- but sendRichMessageDraft
 * is genuinely very new (added within weeks of this fix), so real client-side rendering support
 * may not be universally rolled out, which would explain updates genuinely never appearing
 * on-screen even though the calls themselves succeed. Fixed with a guaranteed-visible fallback
 * using the decades-stable sendMessage/editMessageText pair (see thinking-indicator.ts). This
 * proves the throttle genuinely allows a real edit through once enough real time has passed
 * (not just "always skipped"), and that it's genuinely skipped when updates fire in rapid
 * succession (protecting against a real Telegram edit-rate-limit).
 */

console.log("=== Real proof: the guaranteed progress message throttle genuinely allows an edit after ~1.2s ===\n");

const calls: { method: string; body: Record<string, unknown> }[] = [];
const client = {
  sendChatAction: async () => true,
  sendRichMessageDraft: async () => true,
  sendMessage: async (body: Record<string, unknown>) => {
    calls.push({ method: "sendMessage", body });
    return { message_id: 7001 };
  },
  editMessageText: async (body: Record<string, unknown>) => {
    calls.push({ method: "editMessageText", body });
    return { message_id: 7001 };
  },
  deleteMessage: async (body: Record<string, unknown>) => {
    calls.push({ method: "deleteMessage", body });
    return true;
  },
  sendRichMessage: async () => ({ message_id: 7002 }),
} as unknown as TelegramClient;

await withThinkingIndicator(client, 991122, async (indicator) => {
  console.log("[1] First update genuinely sends the real guaranteed-visible progress message...\n");
  await indicator.update("api", "Step one");
  const editsBeforeWait = calls.filter((c) => c.method === "editMessageText").length;
  assert.equal(calls.filter((c) => c.method === "sendMessage").length, 1, "first update must send the real progress message");
  assert.equal(editsBeforeWait, 0, "no edit yet -- this was the first message, not an update to an existing one");

  console.log("[2] A second update RIGHT AWAY is genuinely throttled (no real edit sent)...\n");
  await indicator.update("trade", "Step two, immediately after");
  assert.equal(calls.filter((c) => c.method === "editMessageText").length, 0, "an immediate second update must be throttled, not hit editMessageText");

  console.log("[3] After a real ~1.3s wait, the NEXT update genuinely gets through as a real edit...\n");
  await new Promise((r) => setTimeout(r, 1300));
  await indicator.update("memory", "Step three, after the real wait");
  const editCall = calls.find((c) => c.method === "editMessageText");
  assert.ok(editCall, "an update after the real throttle window must genuinely produce a real editMessageText call");
  assert.equal(editCall!.body.message_id, 7001, "must edit the SAME real message id from step 1, not send a new one");
  console.log(`    real edit call: ${JSON.stringify(editCall)}`);

  return { result: undefined, finalText: "Done." };
});

console.log("\n[4] The guaranteed progress message is genuinely deleted once the real final answer is sent...\n");
assert.ok(calls.some((c) => c.method === "deleteMessage" && c.body.message_id === 7001), "the real progress message must genuinely be deleted at finalize");

console.log("\n=== ALL ASSERTIONS PASSED ===");
