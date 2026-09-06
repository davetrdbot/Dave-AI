import assert from "node:assert/strict";
import { markdownToTelegramHtml, fmt } from "../src/rich-format.js";

/**
 * Real proof for item 4: "confirm the markdown->Telegram-HTML converter ALSO correctly handles
 * italic, underline, strikethrough, spoiler, inline code, pre/code blocks with syntax
 * highlighting, blockquote, expandable blockquote, links -- test each one individually."
 * Previously only bold/tables were exercised (step54); underline/strikethrough/spoiler/
 * blockquote/links had NO markdown detection in the converter at all before this pass.
 */

console.log("=== Real proof: every formatting type renders as real Telegram HTML, individually ===\n");

console.log("[1] Italic: *text* and _text_...");
assert.equal(markdownToTelegramHtml("This is *italic* text."), "This is <i>italic</i> text.");
assert.equal(markdownToTelegramHtml("This is _also italic_ text."), "This is <i>also italic</i> text.");
console.log(`    "*italic*" -> "${markdownToTelegramHtml("*italic*")}"`);

console.log("\n[2] Underline: ++text++...");
assert.equal(markdownToTelegramHtml("Please ++pay attention++ here."), "Please <u>pay attention</u> here.");
console.log(`    "++pay attention++" -> "${markdownToTelegramHtml("++pay attention++")}"`);

console.log("\n[3] Strikethrough: ~~text~~ (GFM)...");
assert.equal(markdownToTelegramHtml("The old price was ~~$100~~ now $80."), "The old price was <s>$100</s> now $80.");
console.log(`    "~~$100~~" -> "${markdownToTelegramHtml("~~$100~~")}"`);

console.log("\n[4] Spoiler: ||text||...");
assert.equal(markdownToTelegramHtml("The answer is ||42||."), "The answer is <tg-spoiler>42</tg-spoiler>.");
console.log(`    "||42||" -> "${markdownToTelegramHtml("||42||")}"`);

console.log("\n[5] Inline code: `code`...");
assert.equal(markdownToTelegramHtml("Run `npm install` first."), "Run <code>npm install</code> first.");
console.log(`    "\`npm install\`" -> "${markdownToTelegramHtml("`npm install`")}"`);

console.log("\n[6] Pre/code block WITH syntax highlighting (fenced with a language tag)...");
const fenced = "```python\nprint('hi')\n```";
const fencedOut = markdownToTelegramHtml(fenced);
console.log(`    "${fenced.replace(/\n/g, "\\n")}" -> "${fencedOut}"`);
assert.equal(fencedOut, '<pre><code class="language-python">print(\'hi\')</code></pre>');

console.log("\n[7] Pre/code block WITHOUT a language...");
const fencedPlain = "```\nraw output\n```";
const fencedPlainOut = markdownToTelegramHtml(fencedPlain);
console.log(`    -> "${fencedPlainOut}"`);
assert.equal(fencedPlainOut, "<pre>raw output</pre>");

console.log("\n[8] Blockquote: > text...");
assert.equal(markdownToTelegramHtml("> This is a real quote"), "<blockquote>This is a real quote</blockquote>");
const multiLineQuote = markdownToTelegramHtml("> line one\n> line two");
console.log(`    multi-line quote -> "${multiLineQuote}"`);
assert.equal(multiLineQuote, "<blockquote>line one\nline two</blockquote>");

console.log("\n[9] Expandable blockquote: >> text (Telegram's own extension)...");
assert.equal(markdownToTelegramHtml(">> A long note that's collapsed by default"), "<blockquote expandable>A long note that's collapsed by default</blockquote>");
console.log(`    ">> ..." -> "${markdownToTelegramHtml(">> collapsed note")}"`);

console.log("\n[10] Links: [text](url)...");
assert.equal(markdownToTelegramHtml("See [the docs](https://example.com/docs) for more."), 'See <a href="https://example.com/docs">the docs</a> for more.');
console.log(`    "[the docs](https://example.com/docs)" -> "${markdownToTelegramHtml("[the docs](https://example.com/docs)")}"`);

console.log("\n[11] A URL containing underscores/asterisks is NOT misread as italic/bold formatting...");
const trickyUrl = markdownToTelegramHtml("[link](https://example.com/a_b*c)");
console.log(`    "${trickyUrl}"`);
assert.equal(trickyUrl, '<a href="https://example.com/a_b*c">link</a>');

console.log("\n[12] A single message combining several real formatting types together, all correct at once...");
const combined = markdownToTelegramHtml("**Bold**, *italic*, ~~strike~~, ||spoiler||, ++underline++, `code`, and a [link](https://x.com).\n\n> A quoted note");
console.log(`    "${combined}"`);
assert.match(combined, /<b>Bold<\/b>/);
assert.match(combined, /<i>italic<\/i>/);
assert.match(combined, /<s>strike<\/s>/);
assert.match(combined, /<tg-spoiler>spoiler<\/tg-spoiler>/);
assert.match(combined, /<u>underline<\/u>/);
assert.match(combined, /<code>code<\/code>/);
assert.match(combined, /<a href="https:\/\/x\.com">link<\/a>/);
assert.match(combined, /<blockquote>A quoted note<\/blockquote>/);
assert.ok(!combined.includes("**") && !combined.includes("~~") && !combined.includes("||") && !combined.includes("++"), "no raw markdown syntax may survive");

console.log("\n[13] Direct fmt.* API (used for programmatically-built messages, not model text) -- confirms every real tag is correct HTML, not just the markdown auto-detection path...");
assert.equal(fmt.underline("x"), "<u>x</u>");
assert.equal(fmt.strikethrough("x"), "<s>x</s>");
assert.equal(fmt.spoiler("x"), "<tg-spoiler>x</tg-spoiler>");
assert.equal(fmt.blockquote("x"), "<blockquote>x</blockquote>");
assert.equal(fmt.expandableBlockquote("x"), "<blockquote expandable>x</blockquote>");
assert.equal(fmt.link("x", "https://x.com"), '<a href="https://x.com">x</a>');
console.log("    fmt.underline/strikethrough/spoiler/blockquote/expandableBlockquote/link all produce correct real HTML");

console.log("\n=== ALL ASSERTIONS PASSED ===");
