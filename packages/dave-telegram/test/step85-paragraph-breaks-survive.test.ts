import assert from "node:assert/strict";
import { withThinkingIndicator, markdownToTelegramHtml, type TelegramClient } from "../src/index.js";

/**
 * Real proof for the live bug report: "Dave's Telegram messages are still a jam-packed wall of
 * text with no paragraph breaks" even after markdownToTelegramHtml() and IDENTITY.md's "How you
 * communicate" section were already fixed/added in a prior session.
 *
 * Root cause confirmed here end-to-end: markdownToTelegramHtml() itself was never the problem --
 * it already preserves "\n\n" correctly (proven below). The real gap was one step further down
 * the pipe: ThinkingIndicator.finalize() -- the call every ordinary reply from runAgentTurn (and
 * every tg_finalize tool call) goes through -- used to send the converted text via
 * sendRichMessage's `rich_message.html` field. That field is genuine HTML *document* content: a
 * real HTML renderer collapses whitespace runs (including "\n\n") into a single space, exactly
 * like a browser does with raw, un-tagged whitespace in an .html file -- so every paragraph break
 * the model wrote, and that markdownToTelegramHtml() faithfully preserved, was thrown away at the
 * transport layer on every single normal reply. No prompt-level fix could ever have reached that.
 *
 * This test proves the real, fixed behavior end-to-end: a genuine multi-paragraph model reply ->
 * markdownToTelegramHtml() -> ThinkingIndicator.finalize() -> the exact bytes handed to a mocked
 * Telegram transport -- confirming the final call is sendMessage with parse_mode: "HTML" and that
 * "\n\n" between paragraphs survives completely intact in the transmitted text.
 */

console.log("=== Real proof: multi-paragraph model output survives end-to-end to the Telegram payload ===\n");

// A realistic multi-paragraph model reply, the same shape IDENTITY.md's "How you communicate"
// asks for: short paragraphs, a blank line between them, a bullet list in the middle.
const modelReply =
  "Opened a EURUSD long at 1.0950 on a clean structure break.\n\n" +
  "**Why:** momentum and correlation both lined up, and the setup cleared every real confluence check.\n\n" +
  "- Entry: 1.0950\n- SL: 1.0900\n- TP: 1.1050\n\n" +
  "I'll keep watching it and let you know if anything changes.";

console.log("[1] markdownToTelegramHtml() alone preserves every paragraph break...\n");
const converted = markdownToTelegramHtml(modelReply);
console.log(`    converted: ${JSON.stringify(converted)}`);
const paragraphs = converted.split("\n\n");
assert.equal(paragraphs.length, 4, "the 4 real paragraphs/blocks must survive as 4 blank-line-separated chunks");
assert.ok(converted.includes("<b>Why:</b>"), "inline markdown must still convert to real HTML inside a paragraph");
assert.ok(!converted.includes("**"), "no raw markdown syntax should leak through");

console.log("\n[2] The full send path (finalize -> mocked Telegram transport) preserves it too...\n");
const sentCalls: { method: string; body: Record<string, unknown> }[] = [];
const fakeClient = {
  sendChatAction: async () => true,
  sendRichMessageDraft: async () => true,
  sendMessage: async (body: Record<string, unknown>) => {
    sentCalls.push({ method: "sendMessage", body });
    return { message_id: 5150 };
  },
  editMessageText: async (body: Record<string, unknown>) => {
    sentCalls.push({ method: "editMessageText", body });
    return { message_id: 5150 };
  },
  deleteMessage: async (body: Record<string, unknown>) => {
    sentCalls.push({ method: "deleteMessage", body });
    return true;
  },
  // Deliberately present but must NEVER be called for a normal final reply -- if finalize()
  // regresses back to sendRichMessage, this test must fail loudly rather than silently pass.
  sendRichMessage: async (body: Record<string, unknown>) => {
    sentCalls.push({ method: "sendRichMessage", body });
    return { message_id: 9999 };
  },
} as unknown as TelegramClient;

await withThinkingIndicator(fakeClient, 424242, async (indicator) => {
  await indicator.update("trade", "Scoring EURUSD setup");
  return { result: undefined, finalText: markdownToTelegramHtml(modelReply) };
});

const finalSend = sentCalls[sentCalls.length - 1];
console.log(`    final call method: ${finalSend.method}`);
console.log(`    final call body:   ${JSON.stringify(finalSend.body)}`);

assert.equal(finalSend.method, "sendMessage", "the real final answer must go out via sendMessage, not sendRichMessage");
assert.equal(finalSend.body.parse_mode, "HTML", "must set parse_mode: HTML so the converted markup actually renders instead of showing as literal text");
assert.ok(!sentCalls.some((c) => c.method === "sendRichMessage"), "sendRichMessage (which collapses paragraph breaks) must never be used for the real final reply");

const finalText = finalSend.body.text as string;
const sentParagraphs = finalText.split("\n\n");
assert.equal(sentParagraphs.length, 4, "the exact bytes handed to the Telegram transport must still contain all 4 paragraph breaks");
assert.equal(finalText, converted, "the transmitted text must be byte-for-byte the same as markdownToTelegramHtml()'s output -- nothing strips or re-collapses it on the way out");

console.log("\n=== ALL ASSERTIONS PASSED ===");
