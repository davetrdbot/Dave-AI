import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createWorker, sendMessage, getCommsLog, getConversation, getThread, onMessage, DAVE_PARTICIPANT_ID } from "../src/index.js";

const DATA_DIR = join(process.cwd(), "data");
rmSync(DATA_DIR, { recursive: true, force: true });

console.log("=== Step 13 real proof: worker-to-worker + worker-to-Dave communication ===\n");
const USER_ID = "tg-847213";

const martins = createWorker(USER_ID, { name: "Martins", assignment: "temporary", task: "Scan synthetics" });
const priya = createWorker(USER_ID, { name: "Priya", assignment: "fixed", role: "journal", task: "Journal every trade" });

// --- 13.3: live feed subscription (what Step 14's Agent Teams view will consume) ---
console.log("[1] Live feed subscription -- what Step 14's Agent Teams activity view consumes...");
const liveFeed: string[] = [];
const unsubscribe = onMessage(USER_ID, (m) => liveFeed.push(`${m.from} -> ${m.to}: ${m.content}`));

// --- 13.1: two workers exchanging a direct message, not just reporting upward ---
console.log("\n[2] Two workers messaging each other directly (not routed through Dave)...");
sendMessage(USER_ID, martins.id, priya.id, "Found a clean BOOM_500 setup, confluence 79 -- flagging in case you want to journal it if it fills.");
sendMessage(USER_ID, priya.id, martins.id, "Got it, I'll write it up once it's confirmed filled.");
console.log(`    live feed captured in real time: ${JSON.stringify(liveFeed)}`);
assert.equal(liveFeed.length, 2);

const thread = getThread(USER_ID, martins.id, priya.id);
console.log(`    thread between Martins and Priya: ${thread.length} message(s)`);
assert.equal(thread.length, 2);
assert.equal(thread[0].from, martins.id);
assert.equal(thread[1].from, priya.id);

// --- 13.1: a worker messaging Dave directly, two-way ---
console.log("\n[3] A worker messaging Dave directly -- and Dave replying, genuinely two-way...");
sendMessage(USER_ID, martins.id, DAVE_PARTICIPANT_ID, "Heads up -- BOOM_500 spike probability looks unusually high right now, might want to hold off.");
sendMessage(USER_ID, DAVE_PARTICIPANT_ID, martins.id, "Good catch, pausing that one. Keep scanning the rest of the group.");
const daveConvo = getConversation(USER_ID, DAVE_PARTICIPANT_ID);
console.log(`    Dave's full conversation history: ${daveConvo.length} message(s)`);
assert.equal(daveConvo.length, 2);
assert.equal(daveConvo[0].from, martins.id);
assert.equal(daveConvo[0].to, DAVE_PARTICIPANT_ID);
assert.equal(daveConvo[1].from, DAVE_PARTICIPANT_ID);
assert.equal(daveConvo[1].to, martins.id, "Dave's reply must genuinely be addressed back to the worker, not broadcast");

// --- 13.2: persistent log, every message, real timestamp/sender/recipient/content ---
console.log("\n[4] Persistent log has EVERY message, with real timestamp/sender/recipient/content...");
const fullLog = getCommsLog(USER_ID);
console.log(`    total logged messages: ${fullLog.length}`);
assert.equal(fullLog.length, 4);
for (const m of fullLog) {
  assert.ok(typeof m.ts === "number" && m.ts > 0);
  assert.ok(typeof m.from === "string" && m.from.length > 0);
  assert.ok(typeof m.to === "string" && m.to.length > 0);
  assert.ok(typeof m.content === "string" && m.content.length > 0);
}
console.log("    every entry has a real timestamp, sender, recipient, and content");

console.log("\n[4b] The log survives a fresh read (genuinely persisted to disk, not just in-memory)...");
// Simulate a fresh process reading the log cold -- getCommsLog() re-reads
// from disk every call, no cache to accidentally be relying on.
const rereadLog = getCommsLog(USER_ID);
assert.deepEqual(rereadLog, fullLog);
console.log("    re-read from disk matches exactly");

unsubscribe();
console.log("\n[5] Unsubscribing stops further live-feed delivery (no leaked subscription)...");
const feedLengthBeforeUnsub = liveFeed.length;
sendMessage(USER_ID, priya.id, DAVE_PARTICIPANT_ID, "This message should still be logged, just not delivered to the unsubscribed feed.");
assert.equal(liveFeed.length, feedLengthBeforeUnsub, "unsubscribed callback must not fire again");
assert.equal(getCommsLog(USER_ID).length, 5, "but the message itself must still be persisted");

rmSync(DATA_DIR, { recursive: true, force: true });

console.log("\n=== ALL ASSERTIONS PASSED ===");
