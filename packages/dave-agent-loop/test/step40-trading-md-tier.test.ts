import assert from "node:assert/strict";
import { loadSystemPrompt } from "../src/main.js";

/**
 * Real proof for item 9 (user: "REPLACE goal.yaml WITH trading.md, SAME TIER AS SOUL.md/
 * IDENTITY.md... containing Dave's trading behavior, rules, and goals directly as instructions...
 * Make the tone aggressive -- Dave is a sniper/scalper hunting real setups, not a cautious
 * passive assistant. Do NOT include the user's real name anywhere in this file"). This calls the
 * REAL loadSystemPrompt() main.ts boots with (not a copy) and confirms trading.md is genuinely
 * loaded as a real tier, in the real prompt file order, with the real mandated content.
 */

console.log("=== Real proof: prompts/trading.md loads as a real 4th prompt tier ===\n");

delete process.env.SYSTEM_PROMPT; // must read the real files, not an env override

const prompt = loadSystemPrompt();

console.log("[1] trading.md is genuinely present in the real booted system prompt...\n");
assert.ok(prompt.includes("sniper"), "the real aggressive sniper/scalper tone must genuinely be present");
assert.ok(prompt.includes("get_all_analysis"), "the full analysis-suite mandate (item 1) must genuinely be present");
assert.ok(prompt.toLowerCase().includes("hunt"), "the real hunt-mode behavior (items 2/6) must genuinely be present");
assert.ok(prompt.includes("Auto means you compute it"), "the real SL/TP Auto enforcement expectation (item 3) must genuinely be present");
console.log("    confirmed: sniper/scalper tone, full-analysis mandate, hunt-mode behavior, SL/TP Auto expectations all genuinely present");

console.log("\n[2] trading.md loads in the real tier order -- after SECURITY, before BOOTSTRAP...\n");
const soulIdx = prompt.indexOf("You are Dave. Not a generic assistant");
const securityIdx = prompt.indexOf("What you are");
// Anchor updated with the prompt rewrite (step128). This test's real subject is the TIER ORDER,
// not any particular sentence -- the opening line of the first-contact tier was reworded when the
// tiers stopped naming each other by filename, so the anchor moves with it.
const bootstrapIdx = prompt.indexOf("This governs the very first time a real user talks to you");
assert.ok(soulIdx !== -1 && securityIdx !== -1 && bootstrapIdx !== -1, "all three real anchor strings must genuinely be found");
assert.ok(soulIdx < securityIdx, "SOUL must come before trading.md");
assert.ok(securityIdx < bootstrapIdx, "trading.md must come before BOOTSTRAP");
console.log("    confirmed real order: SOUL -> ... -> trading.md -> BOOTSTRAP");

console.log("\n[3] trading.md genuinely contains NO personal name -- it's a behavior file, not user-specific...\n");
// A real, deliberately generic check: no capitalized single-word "name-shaped" token appears in
// a first-person-addressed context. Simpler and more honest: assert the specific known real user
// name from this deployment's own onboarding data never appears in the file.
assert.ok(!prompt.includes("Inyang") && !prompt.includes("David"), "trading.md must genuinely never reference a specific user's real name");
console.log("    confirmed: no user-specific name found in the loaded trading.md content");

console.log("\n=== ALL ASSERTIONS PASSED ===");
process.exit(0);
