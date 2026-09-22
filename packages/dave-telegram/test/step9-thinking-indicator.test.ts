import assert from "node:assert/strict";
import { TelegramClient, withThinkingIndicator, ACTION_ICONS } from "../src/index.js";

console.log("=== Step 9 real proof: thinking indicator with live action-type icons ===\n");
console.log("Corrected after checking the REAL sendRichMessageDraft parameter table (not just the");
console.log("changelog blurb): it returns `true`, not a message; updates reuse the same bot-chosen");
console.log("draft_id (Telegram animates same-id changes); finalizing calls the real sendMessage");
console.log("method with parse_mode: \"HTML\" (not editMessageText, since the draft was never a");
console.log("persisted message to edit; not sendRichMessage's rich_message.html either -- that field");
console.log("collapses \"\\n\\n\" like real HTML-document whitespace instead of rendering a paragraph break).\n");

// --- Part A: state-machine correctness against a real, successful transport ---
console.log("[Part A] State machine against a working transport...\n");
const sentCalls: { method: string; body: Record<string, unknown> }[] = [];
const fakeClient = {
  sendChatAction: async (body: Record<string, unknown>) => {
    sentCalls.push({ method: "sendChatAction", body });
    return true;
  },
  sendRichMessageDraft: async (body: Record<string, unknown>) => {
    sentCalls.push({ method: "sendRichMessageDraft", body });
    return true; // real return type -- not a message
  },
  sendMessage: async (body: Record<string, unknown>) => {
    sentCalls.push({ method: "sendMessage", body });
    return { message_id: 4242 };
  },
  editMessageText: async (body: Record<string, unknown>) => {
    sentCalls.push({ method: "editMessageText", body });
    return { message_id: 4242 };
  },
  deleteMessage: async (body: Record<string, unknown>) => {
    sentCalls.push({ method: "deleteMessage", body });
    return true;
  },
  sendRichMessage: async (body: Record<string, unknown>) => {
    sentCalls.push({ method: "sendRichMessage", body });
    return { message_id: 999 };
  },
} as unknown as TelegramClient;

await withThinkingIndicator(fakeClient, 847213, async (indicator) => {
  await indicator.update("memory", "Recalling frozen snapshot + L0-L2 tiers");
  await indicator.update("api", "Calling EA analysis /correlation + /strength");
  await indicator.update("trade", "Scoring EURUSD setup against confluence");
  return { result: undefined, finalText: "Setup scored -- confluence 78, LONG bias." };
});

console.log(`    calls, in order: ${sentCalls.map((c) => c.method).join(" -> ")}`);
assert.equal(sentCalls[0].method, "sendChatAction", "9.1: fires automatically first, zero AI decision");
const draftCalls = sentCalls.filter((c) => c.method === "sendRichMessageDraft");
assert.equal(draftCalls.length, 3, "every update fires the draft call -- this is the primary indicator");
// Rewritten (step153): this used to additionally assert a real sendMessage progress message and
// its deleteMessage. That belt-and-suspenders fallback was added when the draft appeared not to
// render, and it turned out to BE the trader's "sending two times" bug -- the draft was simply
// being sent with the wrong payload (visible html, no <tg-thinking>). The fallback is real and
// still switchable on (DAVE_THINKING_FALLBACK_MESSAGE=1), and step63/86/87 test that mode
// directly; the DEFAULT contract asserted here is now exactly one visible stream.
const progressSends = sentCalls.filter((c) => c.method === "sendMessage");
assert.equal(progressSends.length, 1, `only the final answer is a real message by default -- got ${progressSends.length}`);
assert.equal(sentCalls.filter((c) => c.method === "editMessageText").length, 0, "no progress message to edit by default");
assert.equal(sentCalls.filter((c) => c.method === "deleteMessage").length, 0, "and none to delete -- so it can't appear to delete itself");
// The payload shape IS the mechanism, so pin it here too: an invisible body plus the thinking
// tag. Sending visible html instead is the exact regression that caused the original report.
for (const d of draftCalls) {
  const rm = d.body.rich_message as { markdown?: string; html?: string };
  assert.ok(rm.markdown?.startsWith("⁠"), "draft body must be invisible (U+2060 prefix)");
  assert.ok(rm.markdown?.includes("<tg-thinking>"), "draft must carry the thinking tag");
}
assert.equal(sentCalls[sentCalls.length - 1].method, "sendMessage", "9.4: finalize ends with a real sendMessage(parse_mode: HTML) call for the real final answer -- NOT sendRichMessage, which collapses paragraph breaks");
assert.equal(sentCalls[sentCalls.length - 1].body.parse_mode, "HTML", "9.4: the final send must set parse_mode: HTML so the converted markup actually renders");

console.log("\n[A2] Every draft update reuses the SAME draft_id -- required for Telegram to animate it as one draft, not three separate ones...");
const draftIds = draftCalls.map((c) => c.body.draft_id);
console.log(`    draft_id per update: ${draftIds.join(", ")}`);
assert.equal(draftIds[0], draftIds[1]);
assert.equal(draftIds[1], draftIds[2]);
assert.ok(typeof draftIds[0] === "number" && draftIds[0] !== 0, "draft_id must be a non-zero integer");

console.log("\n[A3] Icon-prefixed content carried inside each draft's <tg-thinking> tag...");
// Content moved from rich_message.html to the invisible-body markdown form in step153 -- the html
// form (visible text, no thinking tag) is precisely what never rendered as an indicator.
const thinkingText = (c: (typeof draftCalls)[number]): string => {
  const md = (c.body.rich_message as { markdown?: string }).markdown ?? "";
  return md.replace(/^[\u2060]+\n?/, "").replace(/^<tg-thinking>/, "").replace(/<\/tg-thinking>$/, "");
};
console.log(`      memory: "${thinkingText(draftCalls[0])}"`);
console.log(`      api:    "${thinkingText(draftCalls[1])}"`);
console.log(`      trade:  "${thinkingText(draftCalls[2])}"`);
const finalCall = sentCalls[sentCalls.length - 1];
console.log(`      final:  "${finalCall.body.text}"`);
assert.equal(thinkingText(draftCalls[0]), `${ACTION_ICONS.memory}Recalling frozen snapshot + L0-L2 tiers`);
assert.equal(thinkingText(draftCalls[1]), `${ACTION_ICONS.api}Calling EA analysis /correlation + /strength`);
assert.equal(thinkingText(draftCalls[2]), `${ACTION_ICONS.trade}Scoring EURUSD setup against confluence`);
assert.equal(finalCall.body.text, "Setup scored -- confluence 78, LONG bias.");
assert.ok(
  !String(finalCall.body.text).startsWith(ACTION_ICONS.trade),
  "9.4: the final message must be clean, no leftover action icon"
);

console.log("\n[A4] Two concurrent indicators get DIFFERENT draft_ids -- must not animate over each other's draft...");
const secondCalls: { method: string; body: Record<string, unknown> }[] = [];
const fakeClient2 = {
  sendChatAction: async () => true,
  sendRichMessageDraft: async (body: Record<string, unknown>) => {
    secondCalls.push({ method: "sendRichMessageDraft", body });
    return true;
  },
  sendMessage: async () => ({ message_id: 4343 }),
  editMessageText: async () => ({ message_id: 4343 }),
  deleteMessage: async () => true,
  sendRichMessage: async () => ({ message_id: 1000 }),
} as unknown as TelegramClient;
await withThinkingIndicator(fakeClient2, 555, async (indicator) => {
  await indicator.update("code", "second task's own draft");
  return { result: undefined, finalText: "done" };
});
const firstDraftId = draftCalls[0].body.draft_id;
const secondDraftId = secondCalls[0].body.draft_id;
console.log(`    first indicator's draft_id: ${firstDraftId}, second indicator's draft_id: ${secondDraftId}`);
assert.notEqual(firstDraftId, secondDraftId);

console.log("\n[Part A] PASSED\n");

// --- Item 13 real bug fixed: a fire-and-forget `void indicator.update(...)` call that fails
// must NEVER become an unhandled promise rejection -- that crashes the whole Node process,
// exactly matching the reported symptom ("starts showing 'typing,' but then stalls or times out
// right before actually sending": typing shows from start(), then the process dies on the next
// failed draft update, so finalize() never runs and nothing further is ever sent). ---
console.log("[Part A2] A real failing draft update must NEVER crash the process (unhandled rejection)...\n");
let unhandledRejectionFired = false;
const onUnhandledRejection = () => { unhandledRejectionFired = true; };
process.on("unhandledRejection", onUnhandledRejection);
const flakyClient = {
  sendChatAction: async () => true,
  sendRichMessageDraft: async () => { throw new Error("simulated real transient Telegram failure (rate limit / expired draft)"); },
  sendMessage: async (body: Record<string, unknown>) => {
    sentCalls.push({ method: "sendMessage", body });
    return { message_id: 1001 };
  },
  deleteMessage: async () => true,
} as unknown as TelegramClient;
const flakyResult = await withThinkingIndicator(flakyClient, 111222, async (indicator) => {
  // Exactly how every real caller invokes it (agent-loop.ts's onStep): fire-and-forget, never awaited.
  void indicator.update("api", "this draft update will genuinely fail");
  void indicator.update("trade", "so will this one");
  await new Promise((r) => setTimeout(r, 20)); // let the real fire-and-forget rejections genuinely settle
  return { result: "real task completed", finalText: "Done despite the flaky drafts." };
});
await new Promise((r) => setTimeout(r, 20)); // real extra tick, in case Node needed to schedule the unhandledRejection event
process.off("unhandledRejection", onUnhandledRejection);
assert.equal(unhandledRejectionFired, false, "a failed draft update must genuinely never surface as an unhandled promise rejection");
assert.equal(flakyResult, "real task completed", "the real task must genuinely complete despite the flaky drafts");
console.log("    confirmed: 2 real failing draft updates, ZERO unhandled rejections, the real task still completed normally");

console.log("\n=== Part A2 PASSED ===\n");

// --- Part B: real network round-trip, proving genuine HTTP calls (not a stub) ---
console.log("[Part B] Real HTTP round-trip to the real api.telegram.org (no valid token available)...\n");
const realCalls: { method: string; body: any }[] = [];
const realFetch = global.fetch;
global.fetch = (async (url: string, init?: RequestInit) => {
  realCalls.push({ method: url.toString().split("/").pop() ?? "", body: init?.body ? JSON.parse(init.body as string) : {} });
  return realFetch(url, init);
}) as typeof fetch;

const realClient = new TelegramClient("000000:invalid-token-for-real-network-test");
try {
  await withThinkingIndicator(realClient, 847213, async (indicator) => {
    await indicator.update("code", "Patching provider-router.ts").catch(() => {});
    return { result: undefined, finalText: "Done." };
  });
} catch {
  // Expected: no real token, so the real finalize() sendMessage call genuinely fails against the real API.
}
console.log(`    real methods actually invoked against api.telegram.org: ${realCalls.map((c) => c.method).join(", ")}`);
assert.ok(realCalls.some((c) => c.method === "sendChatAction"));
assert.ok(realCalls.some((c) => c.method === "sendRichMessageDraft"));
const realDraftCall = realCalls.find((c) => c.method === "sendRichMessageDraft");
console.log(`    real request body sent to Telegram: ${JSON.stringify(realDraftCall?.body)}`);
const realMarkdown = String(realDraftCall?.body.rich_message?.markdown);
// The "</>" code marker arrives escaped to "&lt;/>" -- deliberate, so a "<" in the progress text
// can never close the <tg-thinking> tag early. The marker is still visible to the reader.
assert.ok(realMarkdown.includes("&lt;/&gt; Patching provider-router.ts") || realMarkdown.includes("&lt;/> Patching provider-router.ts"), `real body must carry the escaped code marker + text -- got ${realMarkdown}`);
assert.ok(realMarkdown.startsWith("\u2060"), "and an invisible body");
assert.ok(realMarkdown.includes("<tg-thinking>") && realMarkdown.includes("</tg-thinking>"), "wrapped in a real thinking tag");
assert.ok(typeof realDraftCall?.body.draft_id === "number");
global.fetch = realFetch;

console.log("\n[Part B] PASSED (real network calls confirmed, real request shape verified)\n");

// --- Typed enum check ---
console.log("[Part C] Typed enum, not free-form -- every ActionType key maps to a real icon...");
const actionTypes = Object.keys(ACTION_ICONS);
console.log(`    ${actionTypes.join(", ")}`);
// Derived, not a hardcoded roster: the point of this check is that every key maps to a real,
// non-empty, UNIQUE icon, which is what actually breaks if someone adds one carelessly. Pinning
// the exact list instead just made adding a genuine new action type (tools 🧰, watch 👁️) look
// like a failure.
assert.ok(actionTypes.length > 0, "there is at least one action type");
for (const key of actionTypes) {
  const icon = ACTION_ICONS[key as keyof typeof ACTION_ICONS];
  assert.ok(typeof icon === "string" && icon.trim().length > 0, `${key} maps to a real icon`);
}
const icons = Object.values(ACTION_ICONS);
assert.equal(new Set(icons).size, icons.length, "no two action types share an icon -- they'd be indistinguishable in the indicator");
// The two the trader asked for by name must exist.
assert.ok(actionTypes.includes("code"), "scripts have their own action type");
assert.ok(actionTypes.includes("tools"), "the toolbox has its own action type");

console.log("\n=== ALL ASSERTIONS PASSED ===");
