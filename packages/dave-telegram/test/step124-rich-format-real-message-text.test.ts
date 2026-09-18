import assert from "node:assert/strict";
import { markdownToTelegramHtml, fmt } from "../src/rich-format.js";

/**
 * Two real bugs fixed (the trader, live: "check the way of writing, fix any bugs for the italic
 * spoiler underline bold and quote").
 *
 * 1. ITALIC ate snake_case. The `_` rule matched ACROSS two unrelated words, so real log text
 *    "VOL_10 shows premium_discount bias" rendered as
 *    "VOL<i>10 shows premium</i>discount bias" -- underscores deleted, wrong text italicised.
 *    This bot is the worst possible case for that: every symbol it trades is snake_case
 *    (VOL_80, CRASH_200, BOOM_100, STORM_500) and so is its whole analysis vocabulary
 *    (premium_discount, tape_flow, spread_pips, risk_metrics), so nearly every message it sent
 *    was being mangled.
 *
 * 2. QUOTE handling produced MALFORMED HTML inside code blocks. Blockquote conversion ran after
 *    code blocks were spliced back in, so a fenced block containing a line starting with ">"
 *    (shell prompt, diff, quoted output) got blockquote tags crossing the <pre> boundary:
 *    "<pre>&gt; npm install\n<blockquote>done</pre></blockquote>". Telegram rejects that with a
 *    400 "can't parse entities" and the WHOLE message is silently lost.
 */

console.log("=== Real proof: the formatter handles this bot's own real message text ===\n");

console.log("[1] Real sentences straight from the trader's Railway logs survive intact...\n");
const realLogLines = [
  "VOL_10 shows premium_discount bias LOOK_SHORT",
  "H4 is STRONG_BEAR with perfect bear MA alignment, tape_flow SELL",
  "BOOM_200 conflicted: H4 STRONG_BULL vs M1 BEAR, spread_pips 10",
  "CRASH_200 at the 52-week low, risk_metrics show mean_reversion",
  "VOL_80 BUY running +$155 toward TP, MTF -5.0, confluence 100 BEAR",
];
for (const line of realLogLines) {
  const out = markdownToTelegramHtml(line);
  assert.equal(out, line, `real log text must pass through untouched -- got ${JSON.stringify(out)}`);
}
console.log(`    confirmed: all ${realLogLines.length} real log lines pass through byte-for-byte, underscores intact`);

console.log("\n[2] Genuine italic prose STILL works -- the fix didn't just disable the feature...\n");
assert.equal(markdownToTelegramHtml("this is _genuinely italic_ here"), "this is <i>genuinely italic</i> here");
assert.equal(markdownToTelegramHtml("and *this one too*"), "and <i>this one too</i>");
console.log("    confirmed: _italic_ and *italic* as real prose both still render");

console.log("\n[3] Every other formatting type the trader asked about...\n");
const checks: [string, string, string][] = [
  ["bold", "**bold** stays", "<b>bold</b> stays"],
  ["underline", "++underlined++", "<u>underlined</u>"],
  ["spoiler", "||secret||", "<tg-spoiler>secret</tg-spoiler>"],
  ["strikethrough", "~~gone~~", "<s>gone</s>"],
  ["quote", "> quoted line\n> second line", "<blockquote>quoted line\nsecond line</blockquote>"],
  ["expandable quote", ">> long quote", "<blockquote expandable>long quote</blockquote>"],
];
for (const [name, input, expected] of checks) {
  const out = markdownToTelegramHtml(input);
  assert.equal(out, expected, `${name} must render correctly -- got ${JSON.stringify(out)}`);
  console.log(`    ${name.padEnd(18)} -> ${out.replace(/\n/g, "\\n")}`);
}

console.log("\n[4] A code block containing '>' lines no longer produces malformed, message-killing HTML...\n");
const codeWithPrompt = markdownToTelegramHtml("```\n> npm install\n> done\n```");
console.log(`    real output: ${JSON.stringify(codeWithPrompt)}`);
assert.equal(codeWithPrompt, "<pre>&gt; npm install\n&gt; done</pre>", "the '>' lines must stay literal inside the code block");
assert.doesNotMatch(codeWithPrompt, /<blockquote/, "a blockquote tag must never be opened inside a code block");
// The exact malformed shape that made Telegram 400 and silently drop the whole message.
assert.doesNotMatch(codeWithPrompt, /<\/pre><\/blockquote>/, "pre and blockquote tags must never interleave");
console.log("    confirmed: no crossed tags, so Telegram no longer rejects and silently drops the message");

console.log("\n[5] Formatting INSIDE a quoted line still survives, which is why order matters...\n");
const boldInQuote = markdownToTelegramHtml("> a **bold** word");
assert.equal(boldInQuote, "<blockquote>a <b>bold</b> word</blockquote>", `got ${JSON.stringify(boldInQuote)}`);
console.log(`    confirmed: ${boldInQuote}`);

console.log("\n[6] Delimiters padded with spaces are not emphasis -- they're just punctuation...\n");
assert.equal(markdownToTelegramHtml("a * b * c"), "a * b * c", "spaced asterisks must not italicise");
assert.equal(markdownToTelegramHtml("5 _ 6 _ 7"), "5 _ 6 _ 7", "spaced underscores must not italicise");
console.log("    confirmed: 'a * b * c' and '5 _ 6 _ 7' pass through unchanged");

console.log("\n[7] The programmatic fmt.* helpers still escape properly (unchanged, re-proven)...\n");
assert.equal(fmt.bold("a<b>c"), "<b>a&lt;b&gt;c</b>", "fmt.bold must escape its input");
assert.equal(fmt.spoiler("x&y"), "<tg-spoiler>x&amp;y</tg-spoiler>", "fmt.spoiler must escape its input");
console.log("    confirmed: fmt.bold and fmt.spoiler still escape user content");

console.log("\n=== ALL ASSERTIONS PASSED ===");
process.exit(0);
