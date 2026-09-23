import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listGroups, getActiveGroupInfo, DEFAULT_PAIR_GROUPS } from "../src/index.js";

/**
 * FLAMES removed entirely (trader, live). The broker's terminal never had enough history for it,
 * so every cycle it came back empty. Removing it from the default seed alone wouldn't reach a
 * trader who already has it saved -- seeding never re-touches a group they already have -- so
 * this proves the on-read cleanup strips FLAMES (and the old misspelling FLAME) from every saved
 * group and from a single-pair focus, and leaves everything else exactly as it was.
 */

console.log("=== FLAMES is gone: from the defaults, and from already-saved groups ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-flames-removed-"));
const OWNER = "user-with-flames-1";

try {
  process.chdir(workDir);

  console.log("[1] The default synthetic group no longer includes it...\n");
  const seed = DEFAULT_PAIR_GROUPS.find((g) => g.id === "synthetic")!;
  assert.ok(!seed.symbols.includes("FLAMES") && !seed.symbols.includes("FLAME"));

  console.log("[2] A saved account that still has FLAMES (and an old FLAME) gets both removed...\n");
  const stateDir = join(workDir, "data", "trading", OWNER);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "pair-groups.json"),
    JSON.stringify({
      groups: [
        { id: "synthetic", name: "Synthetic", symbols: ["BOOM_100", "FLAMES", "CRASH_100", "FLAME"] },
        { id: "forex", name: "Forex", symbols: ["EURUSD", "GBPUSD"] },
      ],
      activeGroupId: "synthetic",
      fallbackGroupId: null,
      pausedForExtremeConditions: false,
      activePairSymbol: "FLAMES",
    }),
    "utf8"
  );
  const groups = listGroups(OWNER);
  assert.deepEqual(groups.find((g) => g.id === "synthetic")!.symbols, ["BOOM_100", "CRASH_100"], "FLAMES and FLAME removed, order of the rest kept");
  assert.deepEqual(groups.find((g) => g.id === "forex")!.symbols, ["EURUSD", "GBPUSD"], "other groups untouched");

  console.log("[3] A single-pair focus on FLAMES is cleared, so scanning falls back to the group...\n");
  const info = getActiveGroupInfo(OWNER);
  assert.equal(info.activePairSymbol, null);
  assert.ok(!info.effectiveSymbols.includes("FLAMES"));

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
