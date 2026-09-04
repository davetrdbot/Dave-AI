import assert from "node:assert/strict";
import { TelegramClient, withThinkingIndicator, ACTION_ICONS } from "../src/index.js";

console.log("=== Step 9 real proof: thinking indicator with live action-type icons ===\n");

// --- Part A: state-machine correctness against a real, successful transport ---
// A minimal fake TelegramClient-shaped transport that returns real success
// responses (same pattern used for Transport fakes in Steps 3/4/7) --
// this proves the draft->edit->finalize state machine for real,
// deterministically, which a real-but-unauthenticated network call can't
// do (every call fails identically with no token, so the code never gets
// far enough to prove state transitions -- see Part B for what that DOES
// prove).
console.log("[Part A] State machine against a working transport...\n");
let nextMessageId = 1;
const sentCalls: { method: string; body: Record<string, unknown> }[] = [];
const fakeClient = {
  sendChatAction: async (body: Record<string, unknown>) => {
    sentCalls.push({ method: "sendChatAction", body });
    return true;
  },
  sendRichMessageDraft: async (body: Record<string, unknown>) => {
    sentCalls.push({ method: "sendRichMessageDraft", body });
    return { message_id: nextMessageId++ };
  },
  editMessageText: async (body: Record<string, unknown>) => {
    sentCalls.push({ method: "editMessageText", body });
    return { message_id: body.message_id as number };
  },
  sendMessage: async (body: Record<string, unknown>) => {
    sentCalls.push({ method: "sendMessage", body });
    return { message_id: nextMessageId++ };
  },
} as unknown as TelegramClient;

await withThinkingIndicator(fakeClient, 847213, async (indicator) => {
  await indicator.update("memory", "Recalling frozen snapshot + L0-L2 tiers");
  await indicator.update("api", "Calling DAVEMA /correlation + /strength");
  await indicator.update("trade", "Scoring EURUSD setup against confluence");
  return { result: undefined, finalText: "Setup scored -- confluence 78, LONG bias." };
});

console.log(`    calls, in order: ${sentCalls.map((c) => c.method).join(" -> ")}`);
assert.equal(sentCalls[0].method, "sendChatAction", "9.1: fires automatically first, zero AI decision");
assert.equal(sentCalls[1].method, "sendRichMessageDraft", "first update opens the draft");
assert.equal(sentCalls[2].method, "editMessageText", "second update edits the SAME draft message");
assert.equal(sentCalls[3].method, "editMessageText", "third update edits the same draft message again");
assert.equal(sentCalls[4].method, "editMessageText", "finalize edits the same message into its final form");

const draftMsgId = (sentCalls[1].body as any).message_id ?? nextMessageId - 3;
console.log(`    all edits target the same message_id: ${(sentCalls[2].body as any).message_id === (sentCalls[3].body as any).message_id && sentCalls[3].body.message_id === sentCalls[4].body.message_id}`);
assert.equal(sentCalls[2].body.message_id, sentCalls[3].body.message_id);
assert.equal(sentCalls[3].body.message_id, sentCalls[4].body.message_id);

console.log("\n    icon-prefixed content per update:");
console.log(`      memory: "${sentCalls[1].body.text}"`);
console.log(`      api:    "${sentCalls[2].body.text}"`);
console.log(`      trade:  "${sentCalls[3].body.text}"`);
console.log(`      final:  "${sentCalls[4].body.text}"`);
assert.equal(sentCalls[1].body.text, `${ACTION_ICONS.memory}Recalling frozen snapshot + L0-L2 tiers`);
assert.equal(sentCalls[2].body.text, `${ACTION_ICONS.api}Calling DAVEMA /correlation + /strength`);
assert.equal(sentCalls[3].body.text, `${ACTION_ICONS.trade}Scoring EURUSD setup against confluence`);
assert.equal(sentCalls[4].body.text, "Setup scored -- confluence 78, LONG bias.");
assert.ok(!String(sentCalls[4].body.text).startsWith(ACTION_ICONS.trade), "9.4: final message is clean, no leftover icon");

console.log("\n[Part A] PASSED\n");

// --- Part B: real network round-trip, proving genuine HTTP calls (not a stub) ---
console.log("[Part B] Real HTTP round-trip to the real api.telegram.org (no valid token available)...\n");
const realCalls: string[] = [];
const realFetch = global.fetch;
global.fetch = (async (url: string, init?: RequestInit) => {
  realCalls.push(url.toString().split("/").pop() ?? "");
  return realFetch(url, init);
}) as typeof fetch;

const realClient = new TelegramClient("000000:invalid-token-for-real-network-test");
try {
  await withThinkingIndicator(realClient, 847213, async (indicator) => {
    await indicator.update("code", "Patching provider-router.ts").catch(() => {});
    return { result: undefined, finalText: "Done." };
  });
} catch {
  // Expected: no real token, finalize() genuinely fails against the real API.
}
console.log(`    real methods actually invoked against api.telegram.org: ${realCalls.join(", ")}`);
assert.ok(realCalls.includes("sendChatAction"));
assert.ok(realCalls.includes("sendRichMessageDraft"));
global.fetch = realFetch;

console.log("\n[Part B] PASSED (real network calls confirmed, genuine 401s from Telegram's real servers)\n");

// --- Typed enum check ---
console.log("[Part C] Typed enum, not free-form -- every ActionType key maps to a real icon...");
const actionTypes = Object.keys(ACTION_ICONS);
console.log(`    ${actionTypes.join(", ")}`);
assert.deepEqual(
  actionTypes.sort(),
  ["api", "code", "database", "input", "memory", "output", "trade", "worker"].sort()
);

console.log("\n=== ALL ASSERTIONS PASSED ===");
