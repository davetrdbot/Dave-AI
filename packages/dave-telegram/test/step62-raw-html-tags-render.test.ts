import assert from "node:assert/strict";
import { markdownToTelegramHtml } from "../src/rich-format.js";

/**
 * Real bug fixed (user, live: a bot message literally showed "<b>every single symbol</b>" as
 * visible text instead of rendering bold). Root cause confirmed: the model sometimes writes
 * genuine Telegram HTML tags directly in its response (not markdown ** syntax) -- IDENTITY.md's
 * "use rich Telegram formatting" instruction doesn't restrict it to markdown-only syntax. The old
 * pipeline blindly HTML-escaped everything that wasn't recognized markdown, which turned the
 * model's own genuine "<b>" into visible "&lt;b&gt;" entity text. Fixed: markdownToTelegramHtml
 * now recognizes the real Telegram HTML-subset tag allowlist and preserves an already-valid tag
 * verbatim instead of escaping it -- while anything that merely LOOKS like a tag but isn't on the
 * real allowlist is still safely escaped (so this doesn't reopen the exact bug class that broke
 * Token Harbor's provider detail view, see command-router.ts's providerDetailView escaping fix).
 */

console.log("=== Real proof: genuine Telegram HTML tags the model writes directly render, not as visible literal text ===\n");

console.log("[1] The EXACT reported case: a literal '<b>...</b>' the model wrote directly renders as real bold, not visible tags...\n");
const out1 = markdownToTelegramHtml("Scanning <b>every single symbol</b> in the group.");
assert.equal(out1, "Scanning <b>every single symbol</b> in the group.");
assert.ok(!out1.includes("&lt;"), "must NOT show escaped literal tag text to the user");
console.log(`    "<b>every single symbol</b>" -> "${out1}" (real bold, not literal tag text)`);

console.log("\n[2] Other real supported tags the model might write directly also survive: <i>, <code>, <tg-spoiler>...\n");
assert.equal(markdownToTelegramHtml("This is <i>directly italic</i>."), "This is <i>directly italic</i>.");
assert.equal(markdownToTelegramHtml("Run <code>npm test</code> now."), "Run <code>npm test</code> now.");
assert.equal(markdownToTelegramHtml("The value is <tg-spoiler>42</tg-spoiler>."), "The value is <tg-spoiler>42</tg-spoiler>.");
console.log("    <i>, <code>, <tg-spoiler> all survive verbatim");

console.log("\n[3] A real <a href=\"...\"> link the model writes directly also survives with its href intact...\n");
const out3 = markdownToTelegramHtml('See <a href="https://example.com">the docs</a> for more.');
assert.equal(out3, 'See <a href="https://example.com">the docs</a> for more.');
console.log(`    real href preserved: "${out3}"`);

console.log("\n[4] Regression guard: an UNSUPPORTED tag-shaped substring is still safely escaped, not live-rendered (the exact Token Harbor bug class must stay fixed)...\n");
const out4 = markdownToTelegramHtml("Also exposes vendor models as tokenharbor/<model>.");
assert.ok(out4.includes("&lt;model&gt;"), "an unsupported tag like <model> must still be escaped, never passed through raw");
assert.ok(!out4.includes("<model>"), "must not leak a raw unsupported tag that would break Telegram's real HTML parser");
console.log(`    "<model>" -> "${out4}" (safely escaped, not passed through as a real tag)`);

console.log("\n[5] Markdown-origin bold/italic still convert correctly alongside genuine literal HTML in the same message...\n");
const out5 = markdownToTelegramHtml("**Markdown bold** and <b>literal HTML bold</b> together.");
assert.equal(out5, "<b>Markdown bold</b> and <b>literal HTML bold</b> together.");
console.log(`    combined: "${out5}"`);

console.log("\n[6] A literal '<b>' written INSIDE a code span/block is still escaped as literal example text, not live-rendered (it's a code example, not real formatting)...\n");
const out6 = markdownToTelegramHtml("Use `<b>text</b>` for bold.");
assert.equal(out6, "Use <code>&lt;b&gt;text&lt;/b&gt;</code> for bold.");
console.log(`    inline code example: "${out6}"`);

console.log("\n=== ALL ASSERTIONS PASSED ===");
