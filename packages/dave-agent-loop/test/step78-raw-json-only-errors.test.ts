import assert from "node:assert/strict";
import { extractRawProviderError, friendlyErrorMessage, AllConfiguredProvidersFailedError } from "../src/error-messages.js";

/**
 * Real proof for the user's explicit, repeated, all-caps instruction: "I want to see the raw json
 * error from the provider... don't add anything to that... just only the json error." Every
 * previous version still wrapped the real error in Dave's own text -- this proves NOTHING is
 * added anymore: no provider name, no "failed", no "switching to", no "[provider] HTTP xxx:"
 * prefix, no "Fix a key..." footer. Just the raw JSON body, exactly as the provider sent it.
 */

console.log("=== Real proof: provider errors reach the user as ONLY the raw JSON, nothing added ===\n");

console.log("[1] The exact real nvidia-nim error the user hit...\n");
const realNvidiaError = '[nvidia-nim] HTTP 404: {"status":404,"title":"Not Found","detail":"Function \'e503b15c-62b0-4d69-b532-a88f0bfa2656\': Not found for account \'l1iKH_cM8Xh0HBROBWVIiRQqyJQ4F6-9kv0oKs3cdSs\'"}';
const extracted = extractRawProviderError(realNvidiaError);
assert.equal(extracted, '{"status":404,"title":"Not Found","detail":"Function \'e503b15c-62b0-4d69-b532-a88f0bfa2656\': Not found for account \'l1iKH_cM8Xh0HBROBWVIiRQqyJQ4F6-9kv0oKs3cdSs\'"}');
assert.ok(!extracted.includes("nvidia-nim"), "the provider name must NOT be added -- the user asked for ONLY the json");
assert.ok(!extracted.includes("HTTP"), "the '[provider] HTTP xxx:' prefix must be genuinely stripped");
console.log(`    real extracted output (nothing added): ${extracted}`);

console.log("\n[2] The final AllConfiguredProvidersFailedError message is ONLY the raw JSON(s), no wrapper at all...\n");
const err = new AllConfiguredProvidersFailedError([{ provider: "nvidia-nim", reason: realNvidiaError }]);
const finalMessage = friendlyErrorMessage(err);
assert.equal(finalMessage, '{"status":404,"title":"Not Found","detail":"Function \'e503b15c-62b0-4d69-b532-a88f0bfa2656\': Not found for account \'l1iKH_cM8Xh0HBROBWVIiRQqyJQ4F6-9kv0oKs3cdSs\'"}');
assert.ok(!finalMessage.includes("None of your configured providers"), "must NOT add the old wrapper header");
assert.ok(!finalMessage.includes("Fix a key"), "must NOT add the old footer");
assert.ok(!finalMessage.includes("⚠️"), "must NOT add any emoji/editorializing at all");
console.log(`    real final message (exactly what reaches the user, nothing more): ${finalMessage}`);

console.log("\n[3] Multiple real failures are each shown as their own raw JSON, still with nothing added...\n");
const multiErr = new AllConfiguredProvidersFailedError([
  { provider: "mistral", reason: 'HTTP 429: {"object":"error","message":"Rate limit exceeded","type":"rate_limited","code":"1300"}' },
  { provider: "nvidia-nim", reason: realNvidiaError },
]);
const multiMessage = friendlyErrorMessage(multiErr);
console.log(`    real multi-provider message:\n${multiMessage}`);
assert.equal(
  multiMessage,
  '{"object":"error","message":"Rate limit exceeded","type":"rate_limited","code":"1300"}\n{"status":404,"title":"Not Found","detail":"Function \'e503b15c-62b0-4d69-b532-a88f0bfa2656\': Not found for account \'l1iKH_cM8Xh0HBROBWVIiRQqyJQ4F6-9kv0oKs3cdSs\'"}'
);

console.log("\n[4] A reason with no JSON at all (a real network-level failure) is returned verbatim, still nothing added...\n");
assert.equal(extractRawProviderError("[groq] request failed/timed out after 20000ms"), "[groq] request failed/timed out after 20000ms");
console.log("    no JSON present -> the raw reason itself, unmodified");

console.log("\n=== ALL ASSERTIONS PASSED ===");
process.exit(0);
