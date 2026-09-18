import assert from "node:assert/strict";
import { loadSystemPrompt } from "../src/main.js";

/**
 * Real proof for the user's explicit ask: "Dave should default to SHORT, direct messages. Only
 * go long when the content genuinely requires it... and when it does go long, it MUST use proper
 * paragraph breaks and spacing, never one dense unbroken block." This calls the REAL
 * loadSystemPrompt() main.ts boots with (not a copy) and confirms the real instruction is present
 * in IDENTITY.md's "How you communicate" section.
 */

console.log("=== Real proof: message-length discipline is a real, loaded system-prompt instruction ===\n");

delete process.env.SYSTEM_PROMPT;
const prompt = loadSystemPrompt();

console.log("[1] The real 'default to short' instruction is genuinely present...\n");
assert.ok(prompt.includes("Default short"), "the real short-by-default instruction must be present");
assert.ok(prompt.includes("Long only when the content genuinely needs it"), "the real 'only go long when needed' instruction must be present");
console.log("    confirmed: short-by-default instruction is genuinely loaded");

console.log("\n[2] The real paragraph-break-when-long instruction is still present (not clobbered by the new instruction)...\n");
// Case-insensitive since the prompt rewrite (step128): the instruction now opens a sentence
// ("Never one dense block."), so a case-sensitive match would fail on wording, not on the rule.
assert.ok(/never one dense block/i.test(prompt), "the real paragraph-break instruction must still be present");
console.log("    confirmed: paragraph-break instruction still present alongside the new short-by-default one");

console.log("\n=== ALL ASSERTIONS PASSED ===");
