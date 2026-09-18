import assert from "node:assert/strict";
import { collapseQueuedMessages, type PendingDelegation } from "../src/delegation.js";

/**
 * Real bug fixed (the trader, live, giving his own timeline: "hi" around 10:11, "trade" around
 * 10:21, "pending" around 10:22 -- "it likes send all of that to the bot which is not good", and
 * the bot "kept on repeating what he just sent").
 *
 * telegram-bot-server.ts's delegate:pause handler ran a SEPARATE full agent turn for every queued
 * message. Three messages sent minutes apart therefore fired three complete turns back to back,
 * each re-reading the same conversation history and re-answering from scratch -- which is exactly
 * how one trade question produced four near-identical multi-paragraph essays in his real chat log.
 */

console.log("=== Real proof: a backlog is answered once, not once per message ===\n");

const CHAT = 4242;
function q(text: string, chatId = CHAT): PendingDelegation {
  return { text, chatId };
}

console.log("[1] The trader's REAL backlog collapses to ONE turn, not three...\n");
const real = collapseQueuedMessages([q("hi"), q("trade"), q("pending")]);
assert.equal(real.length, 1, `three queued messages must produce exactly ONE turn, got ${real.length}`);
assert.equal(real[0].count, 3, "the turn must know it represents three real messages");
assert.equal(real[0].chatId, CHAT);
console.log(`    confirmed: 3 messages -> ${real.length} turn`);

console.log("\n[2] Send order is preserved and every message survives...\n");
const order = real[0].text.indexOf("1. hi") < real[0].text.indexOf("2. trade") && real[0].text.indexOf("2. trade") < real[0].text.indexOf("3. pending");
assert.ok(order, `the original order must be preserved -- got ${JSON.stringify(real[0].text)}`);
for (const msg of ["hi", "trade", "pending"]) {
  assert.ok(real[0].text.includes(`. ${msg}`), `"${msg}" must still be present -- a collapsed backlog must never drop a message`);
}
console.log(`    confirmed: ${JSON.stringify(real[0].text)}`);

console.log("\n[3] The turn is explicitly told not to repeat itself per message...\n");
assert.match(real[0].text, /ONE reply/, "the prompt must ask for a single reply");
assert.match(real[0].text, /don't repeat yourself once per message/, "the real reported symptom must be addressed head on");
console.log("    confirmed: the instruction that fixes the repetition is present");

console.log("\n[4] A LONE queued message is passed through verbatim -- no backlog scaffolding...\n");
const single = collapseQueuedMessages([q("what's the account balance?")]);
assert.equal(single.length, 1);
assert.equal(single[0].text, "what's the account balance?", "a single message must not be wrapped in backlog framing it doesn't need");
assert.equal(single[0].count, 1);
console.log("    confirmed: one message in, that exact text out");

console.log("\n[5] An empty queue produces no turns at all...\n");
assert.deepEqual(collapseQueuedMessages([]), [], "nothing queued must run nothing");
console.log("    confirmed: no phantom turn on an empty queue");

console.log("\n[6] Messages from DIFFERENT chats are never merged into each other...\n");
const multi = collapseQueuedMessages([q("a", 1), q("b", 2), q("c", 1)]);
assert.equal(multi.length, 2, `two chats must produce two turns, got ${multi.length}`);
const chat1 = multi.find((m) => m.chatId === 1)!;
const chat2 = multi.find((m) => m.chatId === 2)!;
assert.equal(chat1.count, 2, "chat 1 had two messages");
assert.equal(chat2.count, 1, "chat 2 had one");
assert.equal(chat2.text, "b", "the single-message chat still passes through verbatim");
assert.doesNotMatch(chat1.text, /\bb\b/, "one chat's messages must never leak into another chat's turn");
console.log("    confirmed: per-chat grouping, no cross-chat leakage");

console.log("\n=== ALL ASSERTIONS PASSED ===");
process.exit(0);
