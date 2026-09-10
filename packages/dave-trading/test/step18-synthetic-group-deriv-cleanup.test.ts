import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listGroups } from "../src/index.js";

/**
 * Real bug fixed (user, explicit): "The Synthetic pair group currently includes Deriv-style
 * symbols... these must be REMOVED entirely. This project only uses Headway broker synthetics."
 * A real user who already seeded groups BEFORE this fix has the old Deriv-style "_INDEX" symbols
 * persisted to disk in their synthetic group -- fixing only DEFAULT_PAIR_GROUPS wouldn't help them,
 * since seeding is additive-only and never re-touches an id the user already has. This proves the
 * real on-read migration strips those symbols out of an already-saved group, in place, without
 * touching any other group or any symbol the user genuinely added themselves.
 */

console.log("=== Real proof: existing users' saved Synthetic group is migrated off Deriv symbols ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-synthetic-cleanup-"));
const OWNER = "user-pre-fix-1";

try {
  process.chdir(workDir);

  console.log("[1] Simulate a pre-fix user: synthetic group already has old Deriv symbols persisted to disk...\n");
  const stateDir = join(workDir, "data", "trading", OWNER);
  mkdirSync(stateDir, { recursive: true });
  const preFixState = {
    groups: [
      {
        id: "synthetic",
        name: "Synthetic",
        symbols: ["BOOM_100", "CRASH_100", "VOLATILITY_75_INDEX", "STEP_INDEX", "JUMP_50_INDEX", "RANGE_BREAK_100_INDEX"],
      },
      { id: "forex", name: "Forex", symbols: ["EURUSD", "GBPUSD"] },
    ],
    activeGroupId: "synthetic",
    fallbackGroupId: null,
    pausedForExtremeConditions: false,
    activePairSymbol: null,
  };
  writeFileSync(join(stateDir, "pair-groups.json"), JSON.stringify(preFixState, null, 2), "utf8");

  console.log("[2] A real read genuinely strips every Deriv '_INDEX' symbol from the synthetic group...\n");
  const groups = listGroups(OWNER);
  const synthetic = groups.find((g) => g.id === "synthetic")!;
  assert.deepEqual(synthetic.symbols, ["BOOM_100", "CRASH_100"], "must keep the real Headway symbols and drop every Deriv one");
  assert.ok(!synthetic.symbols.some((s) => s.includes("_INDEX")), "zero Deriv-style symbols must remain");
  console.log(`    synthetic group after migration: ${synthetic.symbols.join(", ")}`);

  console.log("\n[3] The unrelated forex group is untouched by the migration...\n");
  const forex = groups.find((g) => g.id === "forex")!;
  assert.deepEqual(forex.symbols, ["EURUSD", "GBPUSD"]);
  console.log("    forex group symbols unchanged -- migration is scoped to the synthetic group only");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
