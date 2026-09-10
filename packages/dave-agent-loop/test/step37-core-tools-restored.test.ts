import assert from "node:assert/strict";
import { CORE_TOOL_NAMES, MAX_TOOLS_PER_REQUEST } from "../src/tool-selection.js";

/**
 * Real proof for items 4 & 11 (user: "pin message... memory-write tools appear to have vanished
 * despite being reported as built earlier"). Root cause traced to Cause A: real, registered tools
 * that simply weren't in the curated CORE set sent by default. This asserts they're genuinely
 * promoted now, and that CORE_TOOL_NAMES still stays well under the real provider cap.
 */

console.log("=== Real proof: pin/unpin + memory-write tools are genuinely core, not discovery-only ===\n");

for (const name of ["pin_message", "unpin_message", "remember_user_fact", "remember_note", "remember_adaptability_note"]) {
  assert.ok(CORE_TOOL_NAMES.includes(name), `CORE_TOOL_NAMES must genuinely include "${name}"`);
}
console.log(`    confirmed present in CORE_TOOL_NAMES: pin_message, unpin_message, remember_user_fact, remember_note, remember_adaptability_note`);

assert.ok(CORE_TOOL_NAMES.length < MAX_TOOLS_PER_REQUEST, "CORE_TOOL_NAMES must still stay well under the real provider cap after promotion");
console.log(`    CORE_TOOL_NAMES.length = ${CORE_TOOL_NAMES.length}, still under the real ${MAX_TOOLS_PER_REQUEST}-tool cap`);

console.log("\n=== ALL ASSERTIONS PASSED ===");
process.exit(0);
