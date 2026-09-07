import assert from "node:assert/strict";
import { isQuotaExhaustedError, isRateLimitedError } from "../src/index.js";

/**
 * Real bug fixed, reported directly by the user with a real screenshot of the live bot: Dave told
 * them "mistral ran out of credit" while the real error shown right below it said "Rate limit
 * exceeded" (Mistral's real 429, code "rate_limited") -- a genuine, temporary rate limit is NOT
 * the same real condition as an exhausted quota/billing plan, but the old `isQuotaExhaustedError`
 * regex matched a bare 429/"rate limit exceeded"/"too many requests" as quota exhaustion too. This
 * proves the real, corrected distinction.
 */

console.log("=== Real proof: a plain rate limit is genuinely distinct from quota/billing exhaustion ===\n");

const realMistralRateLimit = 'HTTP 429: {"object":"error","message":"Rate limit exceeded","type":"rate_limited","param":null,"code":"1300","raw_status_code":429}';

console.log("[1] The exact real Mistral error the user hit must NOT be classified as quota exhaustion...");
assert.equal(isQuotaExhaustedError(realMistralRateLimit), false, "a plain rate limit is not a credit/billing problem -- must not be reported as 'ran out of credit'");
assert.equal(isRateLimitedError(realMistralRateLimit), true, "it must genuinely be recognized as a real, temporary rate limit");
console.log("    genuinely NOT quota-exhausted, genuinely IS rate-limited -- matches the real Mistral response");

console.log("\n[2] A genuine quota/billing exhaustion still correctly classifies as quota-exhausted...");
assert.equal(isQuotaExhaustedError('HTTP 429: {"error":{"code":"insufficient_quota","message":"You exceeded your current quota, please check your plan and billing details."}}'), true);
assert.equal(isQuotaExhaustedError("HTTP 402: Payment Required"), true);
console.log("    genuine quota/billing errors still correctly detected");

console.log("\n[3] A generic transient failure is neither...");
assert.equal(isQuotaExhaustedError("HTTP 500: internal server error"), false);
assert.equal(isRateLimitedError("HTTP 500: internal server error"), false);
assert.equal(isQuotaExhaustedError("fetch failed: ECONNRESET"), false);
assert.equal(isRateLimitedError("fetch failed: ECONNRESET"), false);
console.log("    neither category fires for an unrelated transient error");

console.log("\n=== ALL ASSERTIONS PASSED ===");
process.exit(0);
