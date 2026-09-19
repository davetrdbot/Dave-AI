import assert from "node:assert/strict";
import { TELEGRAM_TOOLS } from "../src/tools.js";

/**
 * Real feature (the trader: "read the telegram rich text editor docs... the loading tool, the send
 * draft, and all the rich text editor -- we'll implement all of them, give me the bot tool on
 * that"). Confirmed live (Firecrawl, 2026-09-19) against the real Bot API 10.1-10.3: sendRichMessage
 * / sendRichMessageDraft are genuinely real (added Bot API 10.1, June 2026 -- after the training
 * cutoff, which is why an earlier note wrongly suspected them). The gap was never the client -- it
 * already had setMessageReaction, deleteMessage, stopPoll, sendRichMessageDraft and every
 * sendChatAction value -- it was that Dave had no TOOL for any of them. These are those tools.
 */

/** A fake client that records exactly what each tool asked the Bot API to do. */
function fakeClient() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const rec = (method: string) => (params: Record<string, unknown>) => {
    calls.push({ method, params });
    return Promise.resolve(true as unknown);
  };
  return {
    calls,
    client: {
      setMessageReaction: rec("setMessageReaction"),
      deleteMessage: rec("deleteMessage"),
      stopPoll: rec("stopPoll"),
      sendRichMessageDraft: rec("sendRichMessageDraft"),
      sendChatAction: rec("sendChatAction"),
    },
  };
}

const CHAT = 4242;
function tool(name: string) {
  const t = TELEGRAM_TOOLS.find((x) => x.name === name);
  assert.ok(t, `tool ${name} must exist`);
  return t!;
}

console.log("=== Real proof: the missing Telegram message-action tools ===\n");

(async () => {
  console.log("[1] react_to_message -> setMessageReaction with one emoji, and clears on empty...\n");
  {
    const f = fakeClient();
    await tool("react_to_message").execute({ messageId: 10, emoji: "🔥" }, { client: f.client as never, chatId: CHAT });
    assert.deepEqual(f.calls[0], { method: "setMessageReaction", params: { chat_id: CHAT, message_id: 10, reaction: [{ type: "emoji", emoji: "🔥" }] } });
    await tool("react_to_message").execute({ messageId: 10, emoji: "" }, { client: f.client as never, chatId: CHAT });
    assert.deepEqual(f.calls[1].params.reaction, [], "an empty emoji clears the reaction");
    console.log("    confirmed: 🔥 reaction set, empty clears");
  }

  console.log("\n[2] delete_message -> deleteMessage by id...\n");
  {
    const f = fakeClient();
    await tool("delete_message").execute({ messageId: 77 }, { client: f.client as never, chatId: CHAT });
    assert.deepEqual(f.calls[0], { method: "deleteMessage", params: { chat_id: CHAT, message_id: 77 } });
    console.log("    confirmed: deletes the right message");
  }

  console.log("\n[3] stop_poll -> stopPoll by id...\n");
  {
    const f = fakeClient();
    await tool("stop_poll").execute({ messageId: 88 }, { client: f.client as never, chatId: CHAT });
    assert.deepEqual(f.calls[0], { method: "stopPoll", params: { chat_id: CHAT, message_id: 88 } });
    console.log("    confirmed: closes the right poll");
  }

  console.log("\n[4] send_rich_draft -> sendRichMessageDraft with the SAME draft_id across updates...\n");
  {
    const f = fakeClient();
    await tool("send_rich_draft").execute({ draftId: 5, html: "<b>building…</b>", canStop: true }, { client: f.client as never, chatId: CHAT });
    await tool("send_rich_draft").execute({ draftId: 5, html: "<b>building…</b>\nmore" }, { client: f.client as never, chatId: CHAT });
    assert.equal(f.calls[0].method, "sendRichMessageDraft");
    assert.equal(f.calls[0].params.draft_id, 5);
    assert.deepEqual(f.calls[0].params.rich_message, { html: "<b>building…</b>" });
    assert.equal(f.calls[0].params.can_stop, true);
    assert.equal(f.calls[1].params.draft_id, 5, "the second update reuses the same draft id, so it replaces rather than sends anew");
    console.log("    confirmed: streams a rich draft under one stable draft id");
  }

  console.log("\n[5] tg_chat_action now accepts every real Bot API action, not just 3...\n");
  {
    const action = tool("tg_chat_action");
    const enumVals = ((action.parameters as { properties: { action: { enum: string[] } } }).properties.action.enum);
    for (const a of ["typing", "upload_photo", "record_video", "upload_video", "record_voice", "upload_voice", "upload_document", "choose_sticker", "find_location", "record_video_note", "upload_video_note"]) {
      assert.ok(enumVals.includes(a), `chat action "${a}" must be offered`);
    }
    assert.equal(enumVals.length, 11, "all 11 real actions, no more no less");
    const f = fakeClient();
    await action.execute({ action: "record_video" }, { client: f.client as never, chatId: CHAT });
    assert.deepEqual(f.calls[0], { method: "sendChatAction", params: { chat_id: CHAT, action: "record_video" } });
    console.log("    confirmed: 11 loading indicators available; record_video reaches the API");
  }

  console.log("\n[6] The new tools are CORE, so Dave actually reaches them (not discovery-gated)...\n");
  const { CORE_TOOL_NAMES } = await import("../../dave-agent-loop/src/tool-selection.js");
  for (const name of ["react_to_message", "delete_message", "stop_poll", "send_rich_draft", "tg_chat_action"]) {
    assert.ok(CORE_TOOL_NAMES.includes(name), `${name} must be core`);
  }
  console.log("    confirmed: react/delete/stop_poll/send_rich_draft/tg_chat_action all core");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
  process.exit(0);
})();
