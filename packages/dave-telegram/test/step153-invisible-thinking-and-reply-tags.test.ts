import assert from "node:assert/strict";
import {
  TelegramClient,
  withThinkingIndicator,
  ThinkingIndicator,
  buildThinkingDraft,
  escapeThinkingText,
  WORD_JOINER,
  INVISIBLE_PREFIX,
  ACTION_ICONS,
} from "../src/index.js";
import { collapseQueuedMessages } from "../../dave-agent-loop/src/delegation.js";

/**
 * The trader live-tested the invisible-thinking technique against a real bot and handed over the
 * exact working payloads, plus two real bug reports:
 *   - "the thinking message like the tool calling indicator sending two times, but sometimes it
 *     later delete it's self tho like normal"
 *   - "add message tag so it can actually tag messages... respond to that same message"
 *
 * This covers both, plus the payload shape itself, since the shape is the whole trick and a
 * regression in it is invisible from the code (the calls still succeed; nothing renders).
 */

console.log("=== Step 153: invisible thinking draft + reply tagging ===\n");

type Call = { method: string; body: Record<string, unknown> };

function fakeClient(calls: Call[], opts: { failDraft?: boolean } = {}) {
  let nextId = 5000;
  return {
    sendChatAction: async (body: Record<string, unknown>) => {
      calls.push({ method: "sendChatAction", body });
      return true as const;
    },
    sendRichMessageDraft: async (body: Record<string, unknown>) => {
      calls.push({ method: "sendRichMessageDraft", body });
      if (opts.failDraft) throw new Error("draft rejected");
      return true as const;
    },
    sendMessage: async (body: Record<string, unknown>) => {
      calls.push({ method: "sendMessage", body });
      return { message_id: nextId++ };
    },
    editMessageText: async (body: Record<string, unknown>) => {
      calls.push({ method: "editMessageText", body });
      return { message_id: 1 };
    },
    deleteMessage: async (body: Record<string, unknown>) => {
      calls.push({ method: "deleteMessage", body });
      return true as const;
    },
  } as unknown as TelegramClient;
}

// ---------------------------------------------------------------------------
console.log("[1] The draft payload carries BOTH ingredients, or it renders nothing\n");

const draft = buildThinkingDraft("Scanning XAUUSD");
assert.ok(draft.markdown.startsWith(INVISIBLE_PREFIX), "must open with the invisible prefix");
assert.equal(INVISIBLE_PREFIX, WORD_JOINER.repeat(3), "prefix is three word joiners");
assert.ok(draft.markdown.includes("<tg-thinking>Scanning XAUUSD</tg-thinking>"), "must wrap the text in the thinking tag");
assert.equal(WORD_JOINER, "⁠", "the word joiner is U+2060 -- the one that passes the empty check alone");
// The whole reason U+2060 works where U+200B/U+FEFF don't: it renders as nothing, yet it is NOT
// whitespace, so a non-empty-text check sees real content. If trim() ever started stripping it,
// the technique would break -- so assert that it doesn't.
assert.equal(INVISIBLE_PREFIX.trim(), INVISIBLE_PREFIX, "the prefix must survive trim -- it is zero-width but not whitespace");
assert.ok(!/\s/.test(WORD_JOINER), "U+2060 is not whitespace");
assert.equal(INVISIBLE_PREFIX.replace(/\p{Cf}/gu, ""), "", "every character in the prefix is a zero-width format char");
console.log(`   payload: ${JSON.stringify(draft.markdown)}`);

// The thinking tag's text may not be empty (live-confirmed), so an empty update must not produce
// <tg-thinking></tg-thinking> -- that would be rejected and the indicator would silently vanish.
assert.ok(buildThinkingDraft("").markdown.includes("<tg-thinking>Working</tg-thinking>"), "empty text must fall back to a non-empty label");
assert.ok(buildThinkingDraft("   ").markdown.includes("<tg-thinking>Working</tg-thinking>"), "whitespace-only text must too");
console.log("   ✓ empty/whitespace text falls back rather than emitting an empty tag");

// A "<" in a tool name must not close the tag early.
assert.equal(escapeThinkingText("a < b & c"), "a &lt; b &amp; c");
// ...but the "</> " code marker is content and has to survive as-is once escaped.
// Only "<" needs escaping (a bare ">" can't open a tag), so the marker survives as "&lt;/>" --
// still visibly the code marker, and no longer able to be read as a tag.
const codeDraft = buildThinkingDraft(`${ACTION_ICONS.code}running a script`);
assert.ok(codeDraft.markdown.includes("&lt;/&gt; running a script") || codeDraft.markdown.includes("&lt;/> running a script"), `the </> marker is escaped, not dropped -- got ${JSON.stringify(codeDraft.markdown)}`);
console.log("   ✓ escaping protects the tag without eating the </> marker\n");

// ---------------------------------------------------------------------------
console.log("[2] The duplicate is gone: one draft stream, no real progress message\n");

{
  const calls: Call[] = [];
  const client = fakeClient(calls);
  const indicator = new ThinkingIndicator(client, 42, "typing", { fallbackMessage: false });
  await indicator.start();
  await indicator.update("api", "Checking live state");
  await indicator.update("trade", "trade execute");
  await indicator.finalize("Done.");
  indicator.stop();

  const drafts = calls.filter((c) => c.method === "sendRichMessageDraft");
  const sends = calls.filter((c) => c.method === "sendMessage");

  assert.equal(drafts.length, 2, "one draft call per update");
  // THE bug: the progress updates must not also arrive as real messages. Only the final answer
  // is a real sendMessage.
  assert.equal(sends.length, 1, `only the final answer is a real message -- got ${sends.length}`);
  assert.equal(sends[0].body.text, "Done.");
  assert.equal(calls.filter((c) => c.method === "editMessageText").length, 0, "nothing to edit in place any more");
  assert.equal(calls.filter((c) => c.method === "deleteMessage").length, 0, "and nothing to delete -- which is why it no longer appears to delete itself");

  // Every draft reuses the SAME id -- that is what animates in place rather than stacking.
  const ids = new Set(drafts.map((d) => d.body.draft_id));
  assert.equal(ids.size, 1, "all updates share one draft_id");
  assert.ok(typeof [...ids][0] === "number" && ([...ids][0] as number) !== 0, "draft_id is a non-zero integer");
  console.log(`   ✓ 2 updates -> 2 draft calls on draft_id ${[...ids][0]}, 1 real message total`);

  // And each draft carried the real thinking payload, not visible text.
  for (const d of drafts) {
    const rm = d.body.rich_message as { markdown?: string; html?: string };
    assert.ok(rm.markdown?.startsWith(INVISIBLE_PREFIX), "draft uses the invisible markdown payload");
    assert.equal(rm.html, undefined, "not the old html-with-visible-text form");
  }
  console.log("   ✓ every draft used the invisible <tg-thinking> payload, not visible html\n");
}

// ---------------------------------------------------------------------------
console.log("[3] The fallback still works when explicitly switched on\n");

{
  const calls: Call[] = [];
  const client = fakeClient(calls);
  const indicator = new ThinkingIndicator(client, 42, "typing", { fallbackMessage: true });
  await indicator.start();
  await indicator.update("api", "Checking");
  await indicator.finalize("Answer.");
  indicator.stop();

  const sends = calls.filter((c) => c.method === "sendMessage");
  assert.equal(sends.length, 2, "progress message + final answer");
  assert.equal(calls.filter((c) => c.method === "deleteMessage").length, 1, "the progress message is cleaned up");
  console.log("   ✓ opt-in fallback: progress message sent then deleted (the old behaviour, preserved)\n");
}

// ---------------------------------------------------------------------------
console.log("[4] A failing draft never breaks the turn\n");

{
  const calls: Call[] = [];
  const client = fakeClient(calls, { failDraft: true });
  const indicator = new ThinkingIndicator(client, 42, "typing", { fallbackMessage: false });
  await indicator.start();
  await indicator.update("memory", "recall memory"); // must not throw
  await indicator.finalize("Still answered.");
  indicator.stop();

  const sends = calls.filter((c) => c.method === "sendMessage");
  assert.equal(sends.length, 1);
  assert.equal(sends[0].body.text, "Still answered.", "the real answer still lands when the draft fails");
  console.log("   ✓ draft failure swallowed; the answer still sends\n");
}

// ---------------------------------------------------------------------------
console.log("[5] The reply is tagged to the message it answers\n");

{
  const calls: Call[] = [];
  const client = fakeClient(calls);
  await withThinkingIndicator(client, 42, async () => ({ result: 1, finalText: "Tagged answer." }), { replyToMessageId: 9137 });

  const send = calls.find((c) => c.method === "sendMessage");
  assert.ok(send, "an answer was sent");
  const rp = send!.body.reply_parameters as { message_id: number; allow_sending_without_reply: boolean };
  assert.equal(rp.message_id, 9137, "tagged to the real incoming message id");
  // Load-bearing: without this, a trader deleting their own message mid-turn makes Telegram
  // reject the send outright and the whole answer is lost.
  assert.equal(rp.allow_sending_without_reply, true, "must degrade to an untagged send, never fail");
  console.log("   ✓ reply_parameters carries the id and allow_sending_without_reply\n");
}

{
  const calls: Call[] = [];
  const client = fakeClient(calls);
  await withThinkingIndicator(client, 42, async () => ({ result: 1, finalText: "Untagged." }));
  const send = calls.find((c) => c.method === "sendMessage");
  assert.equal(send!.body.reply_parameters, undefined, "no id given -> no reply tag, not a broken one");
  console.log("   ✓ absent id produces no tag at all\n");
}

// ---------------------------------------------------------------------------
console.log("[6] Only the FIRST chunk of a long answer is tagged\n");

{
  const calls: Call[] = [];
  const client = fakeClient(calls);
  const indicator = new ThinkingIndicator(client, 42, "typing", { fallbackMessage: false, replyToMessageId: 777 });
  // Comfortably over the 4000-char chunk limit, split on a paragraph boundary.
  const long = "A".repeat(3900) + "\n\n" + "B".repeat(3900) + "\n\n" + "C".repeat(1000);
  await indicator.finalize(long);
  indicator.stop();

  const sends = calls.filter((c) => c.method === "sendMessage");
  assert.ok(sends.length >= 2, `expected multiple chunks, got ${sends.length}`);
  assert.equal((sends[0].body.reply_parameters as { message_id: number }).message_id, 777, "first chunk is tagged");
  for (const s of sends.slice(1)) {
    assert.equal(s.body.reply_parameters, undefined, "later chunks are not tagged -- quoting the question 3x reads as a glitch");
  }
  console.log(`   ✓ ${sends.length} chunks, only the first tagged\n`);
}

// ---------------------------------------------------------------------------
console.log("[7] A collapsed backlog tags the LAST message, not the first\n");

{
  const collapsed = collapseQueuedMessages([
    { text: "what's my balance", chatId: 42, receivedAt: 1, messageId: 100 },
    { text: "wassup", chatId: 42, receivedAt: 2, messageId: 101 },
    { text: "pending orders", chatId: 42, receivedAt: 3, messageId: 102 },
  ]);
  assert.equal(collapsed.length, 1, "one turn per chat");
  assert.equal(collapsed[0].count, 3);
  // The most recent thing they asked, not the oldest -- one collapsed answer can only tag one,
  // and pointing at a message they've since moved past is worse than pointing at the latest.
  assert.equal(collapsed[0].replyToMessageId, 102, "tags the most recent queued message");
  console.log("   ✓ 3 queued messages -> one turn tagged to message 102 (the newest)");

  // Entries written to disk before this field existed must still load.
  const legacy = collapseQueuedMessages([{ text: "old", chatId: 42, receivedAt: 1 }]);
  assert.equal(legacy[0].replyToMessageId, undefined, "a legacy entry with no id yields no tag");
  assert.equal(legacy[0].text, "old", "and still answers normally");
  console.log("   ✓ legacy entries without a messageId still collapse and answer\n");
}

// ---------------------------------------------------------------------------
console.log("[8] The script/tool icons exist and are distinct\n");

assert.equal(ACTION_ICONS.code, "</> ", "scripts get the code marker the trader asked for");
assert.ok(ACTION_ICONS.tools.includes("\u{1F9F0}"), "the toolbox icon");
assert.ok(ACTION_ICONS.watch.includes("\u{1F441}"), "the background-watch icon");
const iconValues = Object.values(ACTION_ICONS);
assert.equal(new Set(iconValues).size, iconValues.length, "no two actions share an icon -- they'd be unreadable in the indicator");
console.log(`   ✓ ${iconValues.length} distinct action icons\n`);

console.log("=== All sections passed ===");
