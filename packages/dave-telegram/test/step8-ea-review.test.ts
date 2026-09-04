import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { personalizeEaFile } from "../src/index.js";
import { createHiddenWebhookServer, readInbox } from "@dave/memory";

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

// --- user-webhook.ts: the EA's real payload shape actually round-trips ---
console.log("\n[2] The EA's real heartbeat payload shape round-trips through the real webhook server...");
const server = createHiddenWebhookServer();
await new Promise<void>((resolve) => server.listen(0, resolve));
const address = server.address();
if (typeof address !== "object" || !address) throw new Error("bind failed");
const port = address.port;

// This mirrors exactly what ea/DaveEA.mq5's PushSnapshot() sends.
const heartbeatBody = JSON.stringify({ type: "heartbeat", payload: { account: 12345678, balance: 10432.1 } });
const res = await fetch(`http://127.0.0.1:${port}${ea.webhookUrl.replace("https://dave.example.com", "")}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: heartbeatBody,
});
const json = await res.json();
console.log(`    POST heartbeat -> ${res.status} ${JSON.stringify(json)}`);
assert.equal(res.status, 200);
const inbox = readInbox(USER_ID);
console.log(`    inbox now has ${inbox.length} item(s), type: "${inbox[0]?.type}"`);
assert.equal(inbox.length, 1);
assert.equal(inbox[0].type, "heartbeat");
assert.deepEqual(inbox[0].payload, { account: 12345678, balance: 10432.1 });

console.log("\n[2b] An unknown push type is now rejected (previously accepted blindly)...");
const badRes = await fetch(`http://127.0.0.1:${port}${ea.webhookUrl.replace("https://dave.example.com", "")}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ type: "not-a-real-type", payload: {} }),
});
console.log(`    POST bogus type -> ${badRes.status} ${JSON.stringify(await badRes.json())}`);
assert.equal(badRes.status, 400);
assert.equal(readInbox(USER_ID).length, 1, "the bogus push must NOT have been stored");

await new Promise<void>((resolve) => server.close(() => resolve()));

rmSync(DATA_DIR, { recursive: true, force: true });

console.log("\n=== ALL ASSERTIONS PASSED ===");
