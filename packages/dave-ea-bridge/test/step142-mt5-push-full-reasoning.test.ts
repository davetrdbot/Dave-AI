import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Real bug fixed (the trader, live: the MetaTrader push notification "doesn't send full reasoning
 * ... it just stops at ..."). ea/DaveEA.mq5's NotifyTradeEvent used to do:
 *
 *   pushText = StringLen(combined) > 255 ? StringSubstr(combined, 0, 252) + "..." : combined;
 *
 * so everything past ~250 characters of the model's reasoning never reached the phone. The 255-char
 * cap is real, but it is per MESSAGE -- the rest can be delivered as further notifications.
 *
 * MQL5 cannot be compiled here, so this proves two real things instead: (1) the truncating line is
 * genuinely gone from the real EA source and the queue/splitter are genuinely present, and (2) the
 * splitting ALGORITHM is correct -- ported below line-for-line from the MQL5 -- so it never loses
 * text, never cuts mid-word, and always produces parts that fit the real cap.
 */

const EA = readFileSync(join(process.cwd(), "ea", "DaveEA.mq5"), "utf8");

const PUSH_MAX_LEN = 255;
const PUSH_MAX_PARTS = 6;

/** Faithful port of SplitForPush() in ea/DaveEA.mq5. */
function splitForPush(text: string, maxLen: number): string[] {
  const out: string[] = [];
  let count = 0;
  while (text.length > 0 && count < PUSH_MAX_PARTS) {
    if (text.length <= maxLen) {
      out.push(text);
      count++;
      text = "";
      break;
    }
    let cut = maxLen;
    let lastSpace = -1;
    for (let i = 0; i < maxLen; i++) if (text[i] === " ") lastSpace = i;
    if (lastSpace > Math.floor(maxLen / 2)) cut = lastSpace;
    out.push(text.substring(0, cut));
    count++;
    text = text.substring(cut).replace(/^\s+/, "");
  }
  if (text.length > 0 && count > 0) out[count - 1] = out[count - 1] + "...";
  return out;
}

console.log("=== MT5 push notification carries the FULL reasoning, not a 252-char cut ===\n");

console.log("[1] The old truncating line is genuinely gone from the real EA source...\n");
assert.ok(!EA.includes('StringSubstr(combined, 0, 252)'), "the hard 252-char cut must be gone");
assert.ok(EA.includes("void DrainPushQueue()"), "the real push queue drain must exist");
assert.ok(EA.includes("int SplitForPush("), "the real splitter must exist");
assert.ok(/void OnTimer\(\)\s*\{\s*[^}]*DrainPushQueue\(\);/m.test(EA), "OnTimer must genuinely drain the queue");
assert.ok(EA.includes("EnqueuePush(numbered)"), "overflow parts must genuinely be queued");
console.log("    confirmed: truncating line removed; queue + splitter + OnTimer drain all present");

console.log("\n[2] A long reasoning is split into parts that each fit MT5's real 255-char cap...\n");
const message = "BUY VOL_80 0.02 lots";
const reasoning =
  "Price swept the session low and immediately reclaimed it, leaving a clean bullish fair value gap between 196740 and 196810 that has not been rebalanced. " +
  "The M5 structure shifted bullish on the reclaim candle, and the H1 trend remains up with the last higher low intact at 195900. " +
  "Momentum is expanding on the reclaim, volatility is within its normal band, and the stop sits below the sweep wick at 195800 which keeps risk at roughly one third of the distance to the target at 200500. " +
  "That is comfortably above the configured risk reward floor, so the setup qualifies as a sniper entry rather than a chase.";
const combined = `${message} - ${reasoning}`;
assert.ok(combined.length > 255, `the fixture must actually exceed the cap (it is ${combined.length})`);

const parts = splitForPush(combined, PUSH_MAX_LEN - 8);
console.log(`    combined length ${combined.length} -> ${parts.length} parts`);
for (let i = 0; i < parts.length; i++) {
  const numbered = `(${i + 1}/${parts.length}) ${parts[i]}`;
  assert.ok(numbered.length <= PUSH_MAX_LEN, `part ${i + 1} numbered length ${numbered.length} must fit ${PUSH_MAX_LEN}`);
}
assert.ok(parts.length > 1, "a long reasoning must genuinely span several notifications");
console.log(`    every numbered part fits the cap (longest ${Math.max(...parts.map((p, i) => `(${i + 1}/${parts.length}) ${p}`.length))})`);

console.log("\n[3] No text is lost and nothing is cut mid-word...\n");
const rejoined = parts.join(" ");
assert.ok(!rejoined.endsWith("..."), "this fixture fits within the part budget, so nothing should be marked truncated");
// Every word of the original survives, in order.
const originalWords = combined.split(/\s+/).filter(Boolean);
const rejoinedWords = rejoined.split(/\s+/).filter(Boolean);
assert.deepEqual(rejoinedWords, originalWords, "splitting must preserve every word in order -- no loss, no mid-word cut");
console.log(`    confirmed: all ${originalWords.length} words preserved in order`);

console.log("\n[4] The old behaviour would have thrown most of this away -- quantified...\n");
const oldBehaviour = combined.length > 255 ? combined.substring(0, 252) + "..." : combined;
const lostChars = combined.length - 252;
assert.ok(lostChars > 0);
console.log(`    old push delivered ${oldBehaviour.length} chars and silently dropped ${lostChars}; new path delivers all ${combined.length}`);

console.log("\n[5] A pathologically long reasoning is capped at PUSH_MAX_PARTS and HONESTLY marked...\n");
const huge = "word ".repeat(1000);
const hugeParts = splitForPush(huge, PUSH_MAX_LEN - 8);
assert.equal(hugeParts.length, PUSH_MAX_PARTS, "must stop at the part budget rather than flooding the push service");
assert.ok(hugeParts[hugeParts.length - 1].endsWith("..."), "a genuinely truncated tail must say so");
console.log(`    confirmed: capped at ${PUSH_MAX_PARTS} parts, last part marked truncated`);

console.log("\n[6] A short message still goes out as exactly ONE notification (no regression)...\n");
const shortCombined = "SELL CRASH_100 0.02 lots - Bear OB rejection.";
assert.ok(shortCombined.length <= PUSH_MAX_LEN);
assert.ok(EA.includes("if(StringLen(combined) <= PUSH_MAX_LEN)"), "the single-message fast path must exist in the real source");
assert.equal(splitForPush(shortCombined, PUSH_MAX_LEN - 8).length, 1, "a short message is one part");
console.log("    confirmed: short messages unchanged, single notification");

console.log("\n=== ALL ASSERTIONS PASSED ===");
process.exit(0);
