import assert from "node:assert/strict";
import { isForexSymbol, isForexMarketOpen, isMarketOpenForSymbol } from "../src/market-hours.js";

/**
 * Real gap fixed (user, live: "whether market is closed that's for forex it shouldn't analyze
 * that even set as fallback too -- it just analyze the active pair group/active pair"). Nothing
 * previously knew whether a specific symbol's real market was open -- only the user's own chosen
 * session window (trading-session-config.ts), an orthogonal, separate concept. Per the user's
 * explicit scope: forex only for now. Proves the real weekend boundary (Fri 22:00 UTC - Sun
 * 22:00 UTC) and that synthetics/anything non-forex is never affected.
 */

console.log("=== Real proof: forex market hours are genuinely enforced, nothing else is touched ===\n");

console.log("[1] isForexSymbol correctly recognizes the forex group id, and shape-sniffs a fallback group...\n");
assert.equal(isForexSymbol("EURUSD", "forex"), true);
assert.equal(isForexSymbol("VOL_10", "forex"), true, "the group id is authoritative -- even an odd symbol in the real forex group counts");
assert.equal(isForexSymbol("EURUSD", "synthetic"), false, "a symbol sitting in a non-forex, non-fallback group is never treated as forex");
assert.equal(isForexSymbol("EURUSD", "fallback"), true, "a 6-letter A-Z shape in an uncategorized group is treated as forex");
assert.equal(isForexSymbol("VOL_10", "fallback"), false, "a non-currency-pair shape in an uncategorized group is never wrongly blocked");
assert.equal(isForexSymbol("EURUSD", null), true, "no group context at all -- shape-sniffing still applies");
console.log("    confirmed: group id is authoritative, shape-sniffing only applies to an uncategorized group");

console.log("\n[2] isForexMarketOpen genuinely enforces the real Fri 22:00 UTC - Sun 22:00 UTC weekend boundary...\n");
const cases: [string, boolean][] = [
  ["2026-09-11T21:59:00Z", true], // Friday, just before close
  ["2026-09-11T22:00:00Z", false], // Friday, right at close
  ["2026-09-11T23:30:00Z", false], // Friday night
  ["2026-09-12T12:00:00Z", false], // all Saturday
  ["2026-09-13T21:59:00Z", false], // Sunday, just before reopen
  ["2026-09-13T22:00:00Z", true], // Sunday, right at reopen
  ["2026-09-14T08:00:00Z", true], // Monday
];
for (const [iso, expectedOpen] of cases) {
  const open = isForexMarketOpen(new Date(iso));
  assert.equal(open, expectedOpen, `${iso} -> expected open=${expectedOpen}, got ${open}`);
}
console.log(`    confirmed: all ${cases.length} real weekend-boundary cases match`);

console.log("\n[3] isMarketOpenForSymbol -- a real forex symbol is genuinely blocked on a Saturday, a synthetic at the exact same timestamp is untouched...\n");
const saturday = new Date("2026-09-12T12:00:00Z");
const forexResult = isMarketOpenForSymbol("EURUSD", "forex", saturday);
assert.equal(forexResult.open, false);
assert.ok(forexResult.reason.length > 0, "a real reason must be given for the skip, not a silent false");
const syntheticResult = isMarketOpenForSymbol("VOL_10", "synthetic", saturday);
assert.equal(syntheticResult.open, true, "a synthetic symbol at the identical Saturday timestamp must be completely unaffected");
console.log(`    confirmed: forex closed (${forexResult.reason}), synthetic still open at the same real timestamp`);

console.log("\n=== ALL ASSERTIONS PASSED ===");
process.exit(0);
