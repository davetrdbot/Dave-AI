import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  requestPairing,
  approvePairing,
  getPairingStatus,
  isPaired,
  BootstrapFlow,
  type Transport,
} from "../src/index.js";
import { appendUserFact, loadFrozenSnapshot, readLive } from "@dave/memory";

// Real, isolated data dir for this test run.
const DATA_DIR = join(process.cwd(), "data");
rmSync(DATA_DIR, { recursive: true, force: true });

const USER_ID = "tg-847213";
const sentMessages: { userId: string; text: string }[] = [];
const transport: Transport = {
  send(userId, text) {
    sentMessages.push({ userId, text });
  },
};

console.log("=== Step 3 real end-to-end proof: pairing -> onboarding -> memory ===\n");

// --- Pairing: 3.5 ---
console.log("[1] First-ever message from an unpaired user...");
assert.equal(getPairingStatus(USER_ID), "unknown");
const request = requestPairing(USER_ID);
console.log(`    -> pairing code issued: ${request.code}, status: ${request.status}`);
assert.equal(request.status, "pending");
assert.equal(isPaired(USER_ID), false);

console.log("[2] Owner approves the pairing by code...");
const approved = approvePairing(request.code);
console.log(`    -> status now: ${approved.status}`);
assert.equal(approved.status, "paired");
assert.equal(isPaired(USER_ID), true);

// --- Bootstrap: 3.6 ---
console.log("\n[3] Pairing confirmed -> Dave speaks first (BOOTSTRAP.md trigger)...");
const flow = new BootstrapFlow(transport);
await flow.start(USER_ID);
assert.equal(sentMessages.length, 2, "opening message + Q1 should both be sent");
console.log(`    Dave: "${sentMessages[0].text.split("\n")[0]}"`);
console.log(`    Dave: "${sentMessages[1].text}"`);
assert.match(sentMessages[1].text, /call you/i);

console.log("\n[4] User answers Q1 (name)...");
const consumed1 = await flow.handleMessage(USER_ID, "David");
assert.equal(consumed1, true);
console.log(`    User: "David"`);
console.log(`    Dave: "${sentMessages[2].text}"`);
assert.match(sentMessages[2].text, /terse|detail/i);

console.log("\n[5] User answers Q2 (communication style)...");
const consumed2 = await flow.handleMessage(USER_ID, "Terse, only check in when it matters");
assert.equal(consumed2, true);
console.log(`    User: "Terse, only check in when it matters"`);
console.log(`    Dave: "${sentMessages[3].text}"`);
assert.match(sentMessages[3].text, /rules file/i);

console.log("\n[6] User acknowledges the rules-file note...");
const consumed3 = await flow.handleMessage(USER_ID, "sounds good");
assert.equal(consumed3, true);
console.log(`    User: "sounds good"`);
console.log(`    Dave: "${sentMessages[4].text}"`);
assert.match(sentMessages[4].text, /David/);
assert.match(sentMessages[4].text, /Terse, only check in when it matters/);

const finalProgress = flow.getProgress(USER_ID);
assert.equal(finalProgress.state, "complete");
console.log(`\n[7] Bootstrap state machine now: "${finalProgress.state}"`);

// --- Memory file population: 3.6/3.4 real proof ---
console.log("\n[8] Real memory file contents on disk after the flow:");
const userMd = readLive(USER_ID, "USER.md");
const adaptabilityMd = readLive(USER_ID, "ADAPTABILITY.md");
console.log(`    USER.md         -> "${userMd}"`);
console.log(`    ADAPTABILITY.md -> "${adaptabilityMd}"`);
assert.match(userMd, /Prefers to be called: David/);
assert.match(adaptabilityMd, /Terse, only check in when it matters/);

// --- Frozen snapshot semantics: 4.1 ---
console.log("\n[9] Frozen snapshot check — a snapshot taken now must NOT see a write made after it...");
const snapshotBefore = loadFrozenSnapshot(USER_ID);
appendUserFact(USER_ID, "This should NOT appear in the earlier frozen snapshot");
assert.equal(snapshotBefore.user, userMd, "frozen snapshot must not mutate");
console.log("    snapshot.user unchanged after later write: PASS (frozen, static-first behavior preserved)");

// --- Real task during onboarding: 3.7 ---
console.log("\n[10] A second, still-onboarding user sends what looks like a real task mid-flow...");
const USER_ID_2 = "tg-991122";
requestPairing(USER_ID_2);
approvePairing(USER_ID_2);
const flow2 = new BootstrapFlow(transport);
const before = sentMessages.length;
await flow2.start(USER_ID_2);
const consumedAsTask = await flow2.handleMessage(
  USER_ID_2,
  "Can you show me what my open positions look like right now please?"
);
assert.equal(consumedAsTask, false, "a real task should not be consumed as an onboarding answer");
const noteMsg = sentMessages[sentMessages.length - 1].text;
console.log(`    Dave: "${noteMsg}"`);
assert.match(noteMsg, /haven't finished getting to know/i);
const progress2 = flow2.getProgress(USER_ID_2);
assert.equal(progress2.state, "awaiting-name", "bootstrap should stay open, not silently advance");
console.log(`    bootstrap state for user 2 remains: "${progress2.state}" (still open, as required)`);
void before;

console.log("\n=== ALL ASSERTIONS PASSED ===");
