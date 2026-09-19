import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workDir = mkdtempSync(join(tmpdir(), "dave-skillrecall-"));
process.env.DAVE_DATA_ROOT = workDir;

const { buildLiveSettingsBlock } = await import("../src/live-context.js");
const { CORE_TOOL_NAMES } = await import("../src/tool-selection.js");
const { createSkill } = await import("@dave/skills");
const { setActiveStrategySkill } = await import("@dave/trading");

/**
 * Real bugs fixed, both the trader's own words:
 *  - "fix the skill so it can recall skill -- implement exactly how your skill works so it will
 *    know when to call it or pop up to the agent." Skills were only ever visible to the model once
 *    ACTIVE, so an installed-but-inactive skill was invisible; Dave couldn't know it existed. A
 *    coding agent instead sees a catalogue of every skill with a "use when" and decides from it.
 *  - "feasibility to check for anything... I don't want to mark levels again." The general
 *    check-anything background system exists and is wired, but none of its tools were core, so Dave
 *    almost never reached the primitive.
 */

const USER = "user-skillrecall";

console.log("=== Real proof: skill recall index + check-anything promoted to core ===\n");

try {
  console.log("[1] With no skills, no skill block is added -- no empty scaffolding...\n");
  const empty = buildLiveSettingsBlock(USER);
  assert.ok(!empty.includes("<available_skills>"), "an empty skill registry must add nothing");
  console.log("    confirmed: clean turn for a user with no skills");

  console.log("\n[2] An installed-but-INACTIVE skill still shows up in the per-turn catalogue...\n");
  const spike = createSkill(USER, {
    name: "Spike Reversal Scalp",
    description: "scalping a CRASH/BOOM spike reversal on M1 after an exhaustion wick",
    content: "M1 only. Wait for a spike, then the first M1 close back inside. Enter the reclaim, stop beyond the wick.",
  } as never);
  const withSkill = buildLiveSettingsBlock(USER);
  assert.match(withSkill, /<available_skills>/, "the catalogue block must appear once a skill exists");
  assert.match(withSkill, /Spike Reversal Scalp/, "the inactive skill's name must be listed");
  assert.match(withSkill, /use when: scalping a CRASH\/BOOM spike reversal/, "and its 'use when', which is how Dave knows it fits");
  assert.ok(withSkill.includes(spike.id), "and its id, so it's actually activatable");
  assert.ok(!withSkill.includes("[ACTIVE NOW]"), "nothing should be marked active yet");
  // The full content of an INACTIVE skill must NOT be dumped every turn -- index is name + use-when only.
  assert.ok(!withSkill.includes("first M1 close back inside"), "an inactive skill's full body must not be injected -- index only");
  console.log("    confirmed: inactive skill is visible by name + use-when, without its full body");

  console.log("\n[3] The catalogue tells Dave to OFFER, never to self-activate...\n");
  assert.match(withSkill, /never switch strategy on your own/i, "the recall must preserve the user-decides-activation rule");
  assert.match(withSkill, /offer to activate it/i, "and tell Dave to surface a fitting skill");
  console.log("    confirmed: awareness without silent self-activation");

  console.log("\n[4] The active skill is MARKED and still fully injected (unchanged behaviour)...\n");
  const second = createSkill(USER, {
    name: "London Open Breakout",
    description: "forex breakout in the first hour of the London session",
    content: "H1 bias, M5 entry on the range break after London open.",
  } as never);
  setActiveStrategySkill(USER, second.id);
  const withActive = buildLiveSettingsBlock(USER);
  assert.match(withActive, /London Open Breakout \[ACTIVE NOW\]/, "the active skill must be marked in the catalogue");
  assert.match(withActive, /<active_strategy_skill>/, "and still fully injected as the lens");
  assert.match(withActive, /H1 bias, M5 entry on the range break/, "the ACTIVE skill's full body is still present (that block is unchanged)");
  // The OTHER, inactive skill is still catalogued but not body-dumped.
  assert.match(withActive, /Spike Reversal Scalp/, "the other skill stays in the catalogue");
  assert.ok(!withActive.includes("first M1 close back inside"), "the inactive skill's body is still withheld");
  console.log("    confirmed: active skill marked + injected; inactive one catalogued only");

  console.log("\n[5] All four check-anything tools are now core -- the primitive is reachable...\n");
  for (const name of ["start_background_check", "list_background_checks", "get_background_check", "stop_background_check"]) {
    assert.ok(CORE_TOOL_NAMES.includes(name), `${name} must be sent every turn -- it was discovery-gated, which is why the check-anything primitive went unused`);
  }
  // mark_level (the cheap mechanical kind) stays core alongside it -- the two kinds coexist.
  for (const name of ["mark_level", "check_marked_levels", "cancel_marked_level"]) {
    assert.ok(CORE_TOOL_NAMES.includes(name), `${name} must stay core`);
  }
  console.log("    confirmed: start/list/get/stop_background_check all core, alongside the mechanical mark_level");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
