import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkill, SKILL_TOOLS } from "../src/index.js";
import { getActiveStrategySkillId, getTradingMode } from "@dave/trading";

/**
 * Part 2 (skill scoping): real proof that a skill can be marked the "active trading strategy"
 * (set_active_strategy_skill/clear_active_strategy_skill/get_active_strategy_skill), that this is
 * genuinely just the existing trading-mode store under a clearer name (no second source of
 * truth), and that setting/clearing it round-trips through both the dave-skills tools AND the
 * dave-trading accessors any other module (e.g. live-context.ts) reads.
 */

console.log("=== Real proof: set/clear/get active trading-strategy skill ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-active-strategy-"));
const OWNER = "user-strategy-1";

async function main() {
  process.chdir(workDir);

  console.log("[1] No active strategy skill by default -- Trading Mode is Auto...\n");
  const setTool = SKILL_TOOLS.find((t) => t.name === "set_active_strategy_skill")!;
  const clearTool = SKILL_TOOLS.find((t) => t.name === "clear_active_strategy_skill")!;
  const getTool = SKILL_TOOLS.find((t) => t.name === "get_active_strategy_skill")!;

  assert.equal(getActiveStrategySkillId(OWNER), undefined);
  const before = (await getTool.execute({}, { userId: OWNER })) as any;
  assert.equal(before.active, false);
  console.log("    confirmed: nothing active, get_active_strategy_skill reports active:false");

  console.log("\n[2] Activating a real skill by id genuinely sets it, visible from dave-trading's own accessor...\n");
  const skill = createSkill(OWNER, {
    name: "M1/M3 Scalp Only",
    description: "A tight scalp strategy -- M1/M3 only, no EMA, no Gann fan.",
    content: "Only ever look at M1 and M3. Enter on a liquidity sweep + immediate reclaim. Never use EMA or Gann-fan levels.",
    source: "self-created",
  });

  const setResult = (await setTool.execute({ skillId: skill.id }, { userId: OWNER })) as any;
  assert.equal(setResult.ok, true);
  assert.equal(setResult.activeStrategySkillId, skill.id);
  assert.equal(getActiveStrategySkillId(OWNER), skill.id, "dave-trading's own accessor must see the same real value");
  assert.equal(getTradingMode(OWNER).mode, "trading-skills", "same underlying store -- no second source of truth");

  const afterSet = (await getTool.execute({}, { userId: OWNER })) as any;
  assert.equal(afterSet.active, true);
  assert.equal(afterSet.skillId, skill.id);
  assert.equal(afterSet.name, skill.name);
  console.log(`    active strategy skill genuinely set: "${afterSet.name}" (${afterSet.skillId})`);

  console.log("\n[3] Setting an unknown skill id is genuinely refused, not silently accepted...\n");
  let refused = false;
  try {
    await setTool.execute({ skillId: "does-not-exist" }, { userId: OWNER });
  } catch {
    refused = true;
  }
  assert.ok(refused, "an unknown skill id must genuinely fail, never silently activate garbage");
  assert.equal(getActiveStrategySkillId(OWNER), skill.id, "the previously-active skill must be unchanged after a refused set");
  console.log("    genuinely refused -- previous active skill unchanged");

  console.log("\n[4] Clearing genuinely returns to no active strategy (Auto)...\n");
  const clearResult = (await clearTool.execute({}, { userId: OWNER })) as any;
  assert.equal(clearResult.ok, true);
  assert.equal(getActiveStrategySkillId(OWNER), undefined);
  assert.equal(getTradingMode(OWNER).mode, "auto");
  const afterClear = (await getTool.execute({}, { userId: OWNER })) as any;
  assert.equal(afterClear.active, false);
  console.log("    genuinely cleared -- back to Auto, get_active_strategy_skill reports active:false");

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
