import assert from "node:assert/strict";
import { classifyProviderError, describeProviderFailure, friendlyErrorMessage, AllConfiguredProvidersFailedError } from "../src/error-messages.js";

/**
 * Real bug fixed (the trader, live, real pasted proof: "⚠️ All configured providers failed:
 * upstage (request failed). Check /providers."): classifyProviderError's generic fallback label
 * ("request failed") carries zero diagnostic content -- the real HTTP status/endpoint text that
 * caused it was silently discarded. Two real fixes: (1) HTTP 400/422/403, previously unclassified,
 * now get their own real labels (a 400/422 from an OpenAI-compatible endpoint like Upstage almost
 * always means the configured model id or a request parameter is wrong for that provider); (2) for
 * whatever genuinely still falls through unclassified, describeProviderFailure() surfaces a real
 * (truncated) snippet of the actual reason instead of the meaningless generic label, so the user
 * has something to actually act on -- restoring the "show the errors from the endpoint" intent
 * without going back to raw, duplicated JSON blobs (step78's own real fix).
 */

console.log("=== Real proof: an unclassified provider failure shows a real reason, never a dead-end generic label ===\n");

console.log("[1] A real HTTP 400 (the likely actual shape of Upstage's live failure) now gets its own real classification...\n");
assert.equal(classifyProviderError('[upstage] HTTP 400: {"error":{"message":"model \'solar-pro4\' does not support this request shape","type":"invalid_request_error"}}'), "bad request -- check the configured model id/parameters");
assert.equal(classifyProviderError("HTTP 422: Unprocessable Entity"), "bad request -- check the configured model id/parameters");
assert.equal(classifyProviderError("HTTP 403: Forbidden"), "forbidden (check key permissions)");
console.log("    confirmed: 400/422/403 are real, named classifications now, not swallowed into the generic fallback");

console.log("\n[2] A genuinely unclassifiable reason (no known code/keyword at all) still returns the plain fallback from classifyProviderError()...\n");
assert.equal(classifyProviderError("upstage said something totally unrecognized"), "request failed");
console.log("    confirmed: classifyProviderError() itself is unchanged for real unclassifiable text");

console.log("\n[3] describeProviderFailure() -- the real fix -- replaces that dead-end fallback with a genuine snippet of the real reason...\n");
const realSnippet = describeProviderFailure("[upstage] upstage said something totally unrecognized");
assert.equal(realSnippet, "upstage said something totally unrecognized", "the [provider] prefix is stripped (redundant -- the provider name is already shown alongside it) and the real text is shown, not a meaningless label");
assert.equal(describeProviderFailure("HTTP 429: rate limited by upstage"), "rate limited", "a recognized classification is untouched -- stays a clean short label, no snippet");
console.log(`    real snippet shown for an unclassifiable reason: "${realSnippet}"`);

console.log("\n[4] End to end: the real AllConfiguredProvidersFailedError message a user actually sees now carries a real reason, not a dead end...\n");
const err = new AllConfiguredProvidersFailedError([{ provider: "upstage", reason: "[upstage] upstage said something totally unrecognized" }]);
const finalMessage = friendlyErrorMessage(err);
assert.equal(finalMessage, "⚠️ All configured providers failed: upstage (upstage said something totally unrecognized). Check /providers.");
assert.ok(!finalMessage.includes("(request failed)"), "the old dead-end generic label must never be what the user actually sees for an unclassified failure");
console.log(`    real final message: ${finalMessage}`);

console.log("\n=== ALL ASSERTIONS PASSED ===");
process.exit(0);
