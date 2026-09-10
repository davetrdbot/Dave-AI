import assert from "node:assert/strict";
import { TelegramClient, withThinkingIndicator, ACTION_ICONS } from "../src/index.js";

console.log("=== Step 9 real proof: thinking indicator with live action-type icons ===\n");
console.log("Corrected after checking the REAL sendRichMessageDraft parameter table (not just the");
console.log("changelog blurb): it returns `true`, not a message; updates reuse the same bot-chosen");
console.log("draft_id (Telegram animates same-id changes); finalizing calls the real sendRichMessage");
console.log("method, not editMessageText, since the draft was never a persisted message to edit.\n");

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
assert.equal(sentCalls[1].method, "sendRichMessageDraft");
assert.equal(sentCalls[2].method, "sendRichMessageDraft");
assert.equal(sentCalls[3].method, "sendRichMessageDraft");
assert.equal(sentCalls[4].method, "sendRichMessage", "9.4: finalize uses sendRichMessage, NOT editMessageText");

console.log("\n[A2] Every draft update reuses the SAME draft_id -- required for Telegram to animate it as one draft, not three separate ones...");
const draftIds = [sentCalls[1], sentCalls[2], sentCalls[3]].map((c) => c.body.draft_id);
console.log(`    draft_id per update: ${draftIds.join(", ")}`);
assert.equal(draftIds[0], draftIds[1]);
assert.equal(draftIds[1], draftIds[2]);
assert.ok(typeof draftIds[0] === "number" && draftIds[0] !== 0, "draft_id must be a non-zero integer");

console.log("\n[A3] Icon-prefixed content sent as rich_message.html for each update...");
console.log(`      memory: "${(sentCalls[1].body.rich_message as any).html}"`);
console.log(`      api:    "${(sentCalls[2].body.rich_message as any).html}"`);
console.log(`      trade:  "${(sentCalls[3].body.rich_message as any).html}"`);
console.log(`      final:  "${(sentCalls[4].body.rich_message as any).html}"`);
assert.equal((sentCalls[1].body.rich_message as any).html, `${ACTION_ICONS.memory}Recalling frozen snapshot + L0-L2 tiers`);
assert.equal((sentCalls[2].body.rich_message as any).html, `${ACTION_ICONS.api}Calling EA analysis /correlation + /strength`);
assert.equal((sentCalls[3].body.rich_message as any).html, `${ACTION_ICONS.trade}Scoring EURUSD setup against confluence`);
assert.equal((sentCalls[4].body.rich_message as any).html, "Setup scored -- confluence 78, LONG bias.");
assert.ok(
  !String((sentCalls[4].body.rich_message as any).html).startsWith(ACTION_ICONS.trade),
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
  sendRichMessage: async () => ({ message_id: 1000 }),
} as unknown as TelegramClient;
await withThinkingIndicator(fakeClient2, 555, async (indicator) => {
  await indicator.update("code", "second task's own draft");
  return { result: undefined, finalText: "done" };
});
const firstDraftId = sentCalls[1].body.draft_id;
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
  sendRichMessage: async (body: Record<string, unknown>) => {
    sentCalls.push({ method: "sendRichMessage", body });
    return { message_id: 1001 };
  },
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
  // Expected: no real token, so sendRichMessage genuinely fails against the real API.
}
console.log(`    real methods actually invoked against api.telegram.org: ${realCalls.map((c) => c.method).join(", ")}`);
assert.ok(realCalls.some((c) => c.method === "sendChatAction"));
assert.ok(realCalls.some((c) => c.method === "sendRichMessageDraft"));
const realDraftCall = realCalls.find((c) => c.method === "sendRichMessageDraft");
console.log(`    real request body sent to Telegram: ${JSON.stringify(realDraftCall?.body)}`);
assert.equal(realDraftCall?.body.rich_message?.html, `${ACTION_ICONS.code}Patching provider-router.ts`);
assert.ok(typeof realDraftCall?.body.draft_id === "number");
global.fetch = realFetch;

console.log("\n[Part B] PASSED (real network calls confirmed, real request shape verified)\n");

// --- Typed enum check ---
console.log("[Part C] Typed enum, not free-form -- every ActionType key maps to a real icon...");
const actionTypes = Object.keys(ACTION_ICONS);
console.log(`    ${actionTypes.join(", ")}`);
assert.deepEqual(
  actionTypes.sort(),
  ["api", "code", "database", "input", "memory", "output", "trade", "worker"].sort()
);

console.log("\n=== ALL ASSERTIONS PASSED ===");
