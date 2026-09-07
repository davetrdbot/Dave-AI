import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { personalizeEaFile } from "../src/index.js";
import { createEaWebhookServer, getLastKnownAccountSnapshot, getEaConnectionStatus } from "@dave/ea-bridge";

const DATA_DIR = join(process.cwd(), "data");
rmSync(DATA_DIR, { recursive: true, force: true });

console.log("=== EA review fixes: real proof ===\n");

// --- ea-file.ts: replaceAll + placeholder guard ---
console.log("[1] personalizeEaFile() produces a file with no leftover {{...}} tokens...");
const USER_ID = "tg-review-001";
const ea = personalizeEaFile(USER_ID, "https://dave.example.com");
assert.ok(!ea.content.includes("{{WEBHOOK_URL}}") && !ea.content.includes("{{TOKEN}}"), "no leftover placeholder tokens");
assert.ok(ea.content.includes(ea.webhookUrl));
assert.ok(ea.content.includes(ea.token));
console.log("    clean, real values substituted throughout");
console.log('    (the file legitimately still contains the literal string "{{" -- that\'s the shipped');
console.log("    OnInit() guard's own placeholder-detection code, not a leftover template token)");

console.log("\n[1b] The OnInit() placeholder guard is present in the shipped template...");
assert.match(ea.content, /StringFind\(WebhookURL, "\{\{"\) >= 0/);
assert.match(ea.content, /INIT_PARAMETERS_INCORRECT/);
console.log("    guard against compiling an un-personalized template is in the generated file");

console.log("\n[1c] WebRequest's return status is actually checked in the shipped template...");
assert.match(ea.content, /int status = WebRequest/);
assert.match(ea.content, /status == -1/);
assert.match(ea.content, /error 4014/);
console.log("    error handling for the 'Allow WebRequest' misconfiguration is present, not silently ignored");

console.log("\n[1d] The StringToCharArray trailing-NUL bug is fixed...");
assert.match(ea.content, /ArrayResize\(post, ArraySize\(post\) - 1\)/);
console.log("    trailing null byte from StringToCharArray is trimmed before WebRequest");

// --- Real bug fixed: the EA's real heartbeat now actually reaches the REAL EA bridge state,
// not a generic hidden-webhook inbox that /account never reads from. This is the exact chain
// (personalizeEaFile's webhookUrl -> the real /hooks/ea/<token> server -> saveAccountSnapshot)
// that was broken end to end before this fix -- a real EA got a 200 back and looked "connected"
// from its own side, but /account showed nothing because it reads getLastKnownAccountSnapshot(),
// which this path never wrote to.
console.log("\n[2] The EA's real heartbeat now genuinely reaches the real EA-bridge account snapshot (not a dead-end inbox)...");
const server = createEaWebhookServer();
await new Promise<void>((resolve) => server.listen(0, resolve));
const address = server.address();
if (typeof address !== "object" || !address) throw new Error("bind failed");
const port = address.port;

assert.equal(getLastKnownAccountSnapshot(USER_ID), undefined, "no snapshot before any real heartbeat");
assert.equal(getEaConnectionStatus(USER_ID).connected, false, "not connected before any real heartbeat");

// This mirrors exactly what ea/DaveEA.mq5's PushSnapshot() sends.
const heartbeatBody = JSON.stringify({
  type: "heartbeat",
  account: "12345678",
  balance: 10432.1,
  equity: 10500,
  margin: 100,
  freeMargin: 10400,
  positions: [],
  pendingOrders: [],
});
const res = await fetch(`http://127.0.0.1:${port}${ea.webhookUrl.replace("https://dave.example.com", "")}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: heartbeatBody,
});
const json = await res.json();
console.log(`    POST heartbeat -> ${res.status} ${JSON.stringify(json)}`);
assert.equal(res.status, 200);
assert.deepEqual(json, { commands: [] }, "the real EA bridge's own response shape (queued commands), not a generic ack");

const snapshot = getLastKnownAccountSnapshot(USER_ID);
console.log(`    /account now reads a real snapshot: ${JSON.stringify(snapshot)}`);
assert.ok(snapshot, "the real EA bridge must have genuinely persisted this heartbeat's account data");
assert.equal(snapshot!.balance, 10432.1);
assert.equal(snapshot!.equity, 10500);

console.log("\n[2b] /connection's real EA-connection status now genuinely reflects this heartbeat...");
assert.equal(getEaConnectionStatus(USER_ID).connected, true, "must now show connected -- this is the exact real-world symptom that was broken");

await new Promise<void>((resolve) => server.close(() => resolve()));

rmSync(DATA_DIR, { recursive: true, force: true });

console.log("\n=== ALL ASSERTIONS PASSED ===");
