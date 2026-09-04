import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  DavemaClient,
  DavemaError,
  isValidDavemaKeyFormat,
  maskDavemaKey,
  DavemaApiKeyFlow,
  getDavemaKey,
  getMaskedDavemaKey,
  storeDavemaKey,
  checkCorrelationBeforeSizing,
  type Transport,
} from "../src/index.js";

const DATA_DIR = join(process.cwd(), "data");
rmSync(DATA_DIR, { recursive: true, force: true });
// Step 19.5: storeDavemaKey/getDavemaKey now encrypt at rest and require this.
process.env.DAVE_CREDENTIALS_KEY ??= "test-only-master-key-not-for-production";

console.log("=== Step 7 real proof: DAVEMA integration ===\n");

// --- 7.2: real HTTPS call, no sandbox routing, no auth needed for /ping ---
console.log("[1] Real live call to DAVEMA /ping (no auth required)...");
const anonClient = new DavemaClient(undefined);
const ping = await anonClient.ping();
console.log(`    real response: ${JSON.stringify(ping)}`);
assert.equal(ping.status, "ok");
assert.ok(ping.time);

// --- Real proof of auth enforcement (no valid key available in this environment) ---
console.log("\n[2] Real live call to /price with NO key -- proves real 401 handling, not fabricated...");
let unauthorizedError: DavemaError | undefined;
try {
  await anonClient.get("price", "EURUSD", "M15");
} catch (err) {
  if (err instanceof DavemaError) unauthorizedError = err;
}
console.log(`    real error: ${unauthorizedError?.message}`);
assert.ok(unauthorizedError);
assert.equal(unauthorizedError!.status, 401);

console.log("\n[3] Real live call to /structure with a garbage key -- confirms the API genuinely validates keys, not just accepts anything...");
const badKeyClient = new DavemaClient("sk_live_" + "0".repeat(48));
let badKeyError: DavemaError | undefined;
try {
  await badKeyClient.get("structure", "EURUSD", "H1");
} catch (err) {
  if (err instanceof DavemaError) badKeyError = err;
}
console.log(`    real error: ${badKeyError?.message}`);
assert.ok(badKeyError);
assert.equal(badKeyError!.status, 401);

console.log(
  "\n    NOTE: full authenticated real-data proof (structure/confluence/etc. returning real\n" +
    "    market fields) needs your actual DAVEMA key -- I don't have one. The 3 real calls above\n" +
    "    (a working /ping, and two real 401s proving the API's own auth enforcement) are honest\n" +
    "    proof of the integration; paste a real key in chat, or send it through the flow below\n" +
    "    once Telegram is live in Step 8, to complete the authenticated version."
);

// --- Key format validation ---
console.log("\n[4] Key format validation...");
assert.equal(isValidDavemaKeyFormat("sk_live_" + "a1b2c3d4e5f6".repeat(4)), true);
assert.equal(isValidDavemaKeyFormat("not-a-key"), false);
assert.equal(isValidDavemaKeyFormat("sk_live_tooshort"), false);
console.log("    valid/invalid formats correctly distinguished");
console.log(`    masked example: ${maskDavemaKey("sk_live_" + "a1b2c3d4e5f6".repeat(4))}`);

// --- Secure credential storage ---
console.log("\n[5] Secure credential storage (SECURITY.md secure path)...");
const USER_ID = "tg-847213";
const fakeTestKey = "sk_live_" + "d3adbeef1234".repeat(4); // clearly a test value, not a real key
storeDavemaKey(USER_ID, fakeTestKey);
const raw = getDavemaKey(USER_ID);
const masked = getMaskedDavemaKey(USER_ID);
console.log(`    stored, raw retrievable for internal use: ${raw === fakeTestKey}`);
console.log(`    masked (safe to display): "${masked}"`);
assert.equal(raw, fakeTestKey);
assert.ok(!masked!.includes(fakeTestKey.slice(10, 40)), "masked value must not leak the middle of the real key");

// --- API key request flow (transport-agnostic, Telegram-shaped) ---
console.log("\n[6] API key request flow (the 'telegram UI to ask for the api key' piece)...");
const USER_ID_2 = "tg-991122";
const sent: { userId: string; text: string }[] = [];
const transport: Transport = { send: (userId, text) => void sent.push({ userId, text }) };
const flow = new DavemaApiKeyFlow(transport);
await flow.ask(USER_ID_2);
console.log(`    Dave: "${sent[0].text.split("\n")[0]}"`);
assert.match(sent[0].text, /DAVEMA API key/);

console.log("\n[6a] User pastes an invalid-looking key...");
const consumed1 = await flow.handleMessage(USER_ID_2, "sk_live_tooshort");
console.log(`    Dave: "${sent[sent.length - 1].text}"`);
assert.equal(consumed1, true);
assert.match(sent[sent.length - 1].text, /doesn't look like/);

console.log("\n[6b] User pastes a validly-formatted key...");
const validTestKey = "sk_live_" + "cafebabe0000".repeat(4);
const consumed2 = await flow.handleMessage(USER_ID_2, validTestKey);
console.log(`    Dave: "${sent[sent.length - 1].text}"`);
assert.equal(consumed2, true);
assert.match(sent[sent.length - 1].text, /Got it -- key saved/);
assert.ok(!sent[sent.length - 1].text.includes(validTestKey), "the confirmation must never echo the full raw key");

console.log("\n[6c] An unrelated chat message is correctly NOT consumed by the key flow...");
const consumed3 = await flow.handleMessage(USER_ID_2, "what's my EURUSD exposure?");
assert.equal(consumed3, false);
console.log("    correctly ignored -- not routed into the key handler");

// --- 7.3: correlation check ---
console.log("\n[7] Correlation check before sizing (7.3) -- real code path, real HTTP calls...");
const client = new DavemaClient(undefined); // no valid key available, but this proves the real call shape
let correlationAttempted = false;
try {
  await checkCorrelationBeforeSizing(client, "GBPUSD");
} catch (err) {
  correlationAttempted = err instanceof DavemaError && err.status === 401;
}
console.log(`    real /correlation + /strength calls made, real 401 (no key) confirms the code path executes for real: ${correlationAttempted}`);
assert.equal(correlationAttempted, true);

rmSync(DATA_DIR, { recursive: true, force: true });

console.log("\n=== ALL ASSERTIONS PASSED ===");
