import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listGroups, getActiveGroupInfo } from "../src/index.js";

/**
 * Real, live bug fixed (user: "It's FLAMES NOT FLAME. YOU CAN UPDATE IT"). The broker's actual
 * MT5 symbol is FLAMES, not FLAME -- the earlier default seed's misspelling meant every real
 * analysis request for it never matched a real symbol, so it always came back "unavailable this
 * cycle." A real user who already seeded groups BEFORE this fix (or set it as their single active
 * pair focus) has "FLAME" persisted to disk -- fixing only DEFAULT_PAIR_GROUPS wouldn't help them,
 * since seeding is additive-only and never re-touches an id the user already has. This proves the
 * real on-read migration renames it in place, in any group, and in activePairSymbol too, without
 * touching any other symbol.
 */

console.log("=== Real proof: an already-persisted \"FLAME\" symbol is migrated to \"FLAMES\" ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-flame-migration-"));
const OWNER = "user-pre-flame-fix-1";

try {
  process.chdir(workDir);

  console.log("[1] Simulate a pre-fix user: synthetic group and activePairSymbol both have the old \"FLAME\" persisted to disk...\n");
  const stateDir = join(workDir, "data", "trading", OWNER);
  mkdirSync(stateDir, { recursive: true });
  const preFixState = {
    groups: [
      { id: "synthetic", name: "Synthetic", symbols: ["BOOM_100", "CRASH_100", "FLAME"] },
      { id: "forex", name: "Forex", symbols: ["EURUSD", "GBPUSD"] },
    ],
    activeGroupId: "synthetic",
    fallbackGroupId: null,
    pausedForExtremeConditions: false,
    activePairSymbol: "FLAME",
  };
  writeFileSync(join(stateDir, "pair-groups.json"), JSON.stringify(preFixState, null, 2), "utf8");

  console.log("[2] A real read genuinely renames \"FLAME\" to \"FLAMES\" in the synthetic group...\n");
  const groups = listGroups(OWNER);
  const synthetic = groups.find((g) => g.id === "synthetic")!;
  assert.deepEqual(synthetic.symbols, ["BOOM_100", "CRASH_100", "FLAMES"], "must rename FLAME to FLAMES in place, keep everything else");
  console.log(`    synthetic group after migration: ${synthetic.symbols.join(", ")}`);

  console.log("\n[3] The unrelated forex group is untouched by the migration...\n");
  const forex = groups.find((g) => g.id === "forex")!;
  assert.deepEqual(forex.symbols, ["EURUSD", "GBPUSD"]);
  console.log("    forex group symbols unchanged -- migration is scoped to the exact \"FLAME\" symbol only");

  console.log("\n[3b] A real persisted activePairSymbol of \"FLAME\" is also migrated to \"FLAMES\"...\n");
  const info = getActiveGroupInfo(OWNER);
  assert.equal(info.activePairSymbol, "FLAMES", "a user who had FLAME set as their single active-pair focus must be migrated too");
  console.log(`    activePairSymbol after migration: ${info.activePairSymbol}`);

  console.log("\n[4] A normal read with no \"FLAME\" anywhere is completely unaffected (regression)...\n");
  const OWNER2 = "user-no-flame-1";
  const stateDir2 = join(workDir, "data", "trading", OWNER2);
  mkdirSync(stateDir2, { recursive: true });
  const cleanState = {
    groups: [{ id: "synthetic", name: "Synthetic", symbols: ["BOOM_100", "FLAMES"] }],
    activeGroupId: "synthetic",
    fallbackGroupId: null,
    pausedForExtremeConditions: false,
    activePairSymbol: null,
  };
  writeFileSync(join(stateDir2, "pair-groups.json"), JSON.stringify(cleanState, null, 2), "utf8");
  const groups2 = listGroups(OWNER2);
  assert.deepEqual(groups2.find((g) => g.id === "synthetic")!.symbols, ["BOOM_100", "FLAMES"], "an already-correct group must be left untouched");
  console.log("    already-correct group left exactly as-is -- migration is a real no-op when nothing needs fixing");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
