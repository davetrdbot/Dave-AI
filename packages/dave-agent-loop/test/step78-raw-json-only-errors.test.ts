import assert from "node:assert/strict";
import { classifyProviderError, friendlyErrorMessage, AllConfiguredProvidersFailedError } from "../src/error-messages.js";

/**
 * Real proof for the user's CURRENT, explicit instruction (item 4 of a connected 9-item bug
 * report, with real pasted proof of raw/duplicated JSON error blobs reaching the chat): "Build a
 * proper universal error-handling wrapper... any raw API error gets caught and converted into ONE
 * clean, human-readable message to the user... never the raw JSON, and never sent twice." This
 * supersedes an EARLIER, since-reversed instruction (this file used to prove raw-JSON-only, no
 * provider name) -- the earlier design's lack of provider attribution turned out to be exactly
 * why a real NVIDIA error got reported to Dave as "Mistral 404" (item 5): with no name on a raw
 * blob, the user could only guess which provider it came from.
 */

console.log("=== Real proof: provider errors reach the user as ONE clean, provider-named line -- never raw JSON, never twice ===\n");

console.log("[1] classifyProviderError() turns real raw error text into a short, honest classification...\n");
const realNvidiaError = '[nvidia-nim] HTTP 404: {"status":404,"title":"Not Found","detail":"Function \'e503b15c-62b0-4d69-b532-a88f0bfa2656\': Not found for account \'l1iKH_cM8Xh0HBROBWVIiRQqyJQ4F6-9kv0oKs3cdSs\'"}';
assert.equal(classifyProviderError(realNvidiaError), "model/endpoint not found");
assert.equal(classifyProviderError('HTTP 429: {"object":"error","message":"Rate limit exceeded","type":"rate_limited","code":"1300"}'), "rate limited");
assert.equal(classifyProviderError('{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}'), "out of credit/quota");
assert.equal(classifyProviderError("400 Bad Request: 'tools': maximum number of items is 128."), "too many tools in request");
assert.equal(classifyProviderError("[groq] request failed/timed out after 20000ms"), "timed out");
console.log("    real classifications confirmed for 404/429/quota/too-many-tools/timeout, all from real error text");

console.log("\n[2] The final AllConfiguredProvidersFailedError message is ONE clean line naming every real provider tried, never raw JSON...\n");
const err = new AllConfiguredProvidersFailedError([{ provider: "nvidia-nim", reason: realNvidiaError }]);
const finalMessage = friendlyErrorMessage(err);
assert.equal(finalMessage, "⚠️ All configured providers failed: nvidia-nim (model/endpoint not found). Check /providers.");
assert.ok(!finalMessage.includes("{"), "must NEVER include the raw JSON body");
assert.ok(!finalMessage.includes("Not found for account"), "must NEVER leak the raw endpoint detail text");
console.log(`    real final message (clean, provider-named, no raw JSON): ${finalMessage}`);

console.log("\n[3] Multiple real failures are named together in ONE line, each with its own real classification -- not duplicated raw blobs...\n");
const multiErr = new AllConfiguredProvidersFailedError([
  { provider: "mistral", reason: 'HTTP 429: {"object":"error","message":"Rate limit exceeded","type":"rate_limited","code":"1300"}' },
  { provider: "nvidia-nim", reason: realNvidiaError },
]);
const multiMessage = friendlyErrorMessage(multiErr);
console.log(`    real multi-provider message: ${multiMessage}`);
assert.equal(multiMessage, "⚠️ All configured providers failed: mistral (rate limited), nvidia-nim (model/endpoint not found). Check /providers.");
assert.equal((multiMessage.match(/\n/g) ?? []).length, 0, "must be ONE line, not a stack of repeated messages");

console.log("\n[4] 'no stored keys' stays a distinct, honestly-labeled internal state, not a fabricated endpoint error...\n");
const noKeysErr = new AllConfiguredProvidersFailedError([{ provider: "claude", reason: 'no stored keys for provider "claude"' }]);
assert.equal(friendlyErrorMessage(noKeysErr), "⚠️ All configured providers failed: claude (no working keys). Check /providers.");

console.log("\n[5] Zero configured providers gets a real, honest, actionable message...\n");
assert.equal(friendlyErrorMessage(new AllConfiguredProvidersFailedError([])), "⚠️ No provider is configured at all — add one via /providers.");

console.log("\n=== ALL ASSERTIONS PASSED ===");
process.exit(0);
