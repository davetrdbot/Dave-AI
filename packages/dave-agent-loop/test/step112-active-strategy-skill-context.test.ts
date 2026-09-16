import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkill } from "@dave/skills";
import { setActiveStrategySkill, clearActiveStrategySkill } from "@dave/trading";
import { buildLiveSettingsBlock } from "../src/live-context.js";

/**
 * Part 2 (skill scoping): real proof that live-context.ts is the actual enforcement mechanism
 * behind "follow the active strategy skill explicitly" -- an `<active_strategy_skill>` block
 * appears in the live-settings block (prepended to every real turn, see live-context.ts's own
 * doc) exactly when a skill is genuinely marked active, and is genuinely absent when none is.
 */

console.log("=== Real proof: <active_strategy_skill> context injection appears/disappears with the real setting ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-strategy-context-"));
const USER = "user-strategy-context-1";

async function main() {
  process.chdir(workDir);

  console.log("[1] With no active strategy skill, the block is genuinely absent...\n");
  const before = buildLiveSettingsBlock(USER);
  assert.ok(!before.includes("<active_strategy_skill>"), "must genuinely be absent when nothing is active");
  console.log("    confirmed absent");

  console.log("\n[2] Activating a real skill makes the block appear, with its real name and content, every turn...\n");
  const skill = createSkill(USER, {
    name: "M1/M3 Scalp Only",
    description: "A tight scalp strategy -- M1/M3 only, no EMA, no Gann fan.",
    content: "Only ever look at M1 and M3. Enter on a liquidity sweep + immediate reclaim. Never use EMA or Gann-fan levels.",
    source: "self-created",
  });
  setActiveStrategySkill(USER, skill.id);

  const after = buildLiveSettingsBlock(USER);
  assert.ok(after.includes("<active_strategy_skill>"), "block must genuinely appear once a skill is active");
  assert.ok(after.includes(skill.name), "the real skill name must be in the injected context");
  assert.ok(after.includes(skill.content), "the real skill content must be in the injected context, not just its name");
  assert.match(after, /follow this explicitly/i, "the explicit-adherence instruction must genuinely be present");
  console.log("    confirmed present, with the real skill's name and full content, plus the explicit-adherence instruction");

  console.log("\n[3] Clearing the active strategy makes the block genuinely disappear again...\n");
  clearActiveStrategySkill(USER);
  const afterClear = buildLiveSettingsBlock(USER);
  assert.ok(!afterClear.includes("<active_strategy_skill>"), "must genuinely disappear once cleared");
  console.log("    confirmed absent again after clearing");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(workDir, { recursive: true, force: true });
  });
