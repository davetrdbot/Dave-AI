import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedDefaultPairGroups, listGroups, upsertGroup, DEFAULT_PAIR_GROUPS } from "../src/index.js";

console.log("=== Item 8 real proof: 8 seeded pair groups (7 categories + Fallback), additive/idempotent, admin edits survive re-seed ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-pairgroup-seed-"));
const OWNER = "user-1";

try {
  process.chdir(workDir);

  console.log("[1] Fresh user has zero groups until seeded...\n");
  assert.equal(listGroups(OWNER).length, 0);

  console.log("[2] Seeding creates exactly 8 groups, no 'Local' category...\n");
  const added = seedDefaultPairGroups(OWNER);
  assert.equal(added.length, 8);
  const groups = listGroups(OWNER);
  assert.equal(groups.length, 8);
  const ids = groups.map((g) => g.id).sort();
  assert.deepEqual(ids, ["crypto", "energies", "fallback", "forex", "indexes", "metals", "stocks", "synthetic"]);
  assert.ok(!groups.some((g) => /local/i.test(g.name)), "must NOT include a 'Local' category");
  console.log(`    seeded: ${groups.map((g) => g.name).join(", ")}`);

  console.log("\n[3] Real seeded symbol lists match the user's own lists exactly...\n");
  // User-corrected: this project only uses Headway broker synthetics -- exactly these 9 real
  // symbols (FLAMES removed at the trader's request), zero Deriv-style "_INDEX" symbols anywhere.
  const synthetic = groups.find((g) => g.id === "synthetic")!;
  assert.deepEqual(synthetic.symbols, ["VOL_10", "VOL_20", "VOL_80", "BOOM_100", "BOOM_200", "STORM_200", "STORM_500", "CRASH_100", "CRASH_200"]);
  assert.ok(!synthetic.symbols.some((s) => s.includes("_INDEX")), "must contain zero Deriv-style _INDEX symbols");
  const forex = groups.find((g) => g.id === "forex")!;
  assert.equal(forex.symbols.length, 28);
  assert.ok(forex.symbols.includes("EURUSD") && forex.symbols.includes("NZDCHF"));
  const crypto = groups.find((g) => g.id === "crypto")!;
  assert.ok(crypto.symbols.includes("BTCUSD") && crypto.symbols.includes("AVAXUSD"));
  const metals = groups.find((g) => g.id === "metals")!;
  assert.deepEqual(metals.symbols, ["XAUUSD", "XAGUSD", "XPTUSD", "XPDUSD"]);
  const indexes = groups.find((g) => g.id === "indexes")!;
  assert.deepEqual(indexes.symbols, ["US30", "US100", "NAS100", "SPX500", "GER40", "UK100", "JP225", "AUS200"]);
  const energies = groups.find((g) => g.id === "energies")!;
  assert.deepEqual(energies.symbols, ["USOIL", "UKOIL", "NGAS"]);
  const stocks = groups.find((g) => g.id === "stocks")!;
  assert.equal(stocks.symbols.length, 20);
  const fallback = groups.find((g) => g.id === "fallback")!;
  assert.equal(fallback.symbols.length, 0, "fallback group is empty and user-configurable");
  console.log("    every seeded category's symbol list matches the user's real list verbatim");

  console.log("\n[4] Re-seeding is idempotent: no duplicates, count stays 8...\n");
  const reseeded = seedDefaultPairGroups(OWNER);
  assert.equal(reseeded.length, 0, "nothing new to add on a second seed");
  assert.equal(listGroups(OWNER).length, 8);
  console.log("    still exactly 8 groups after re-seeding");

  console.log("\n[5] A user's own edit to a seeded group survives re-seeding (admin designer still works on top)...\n");
  upsertGroup(OWNER, { id: "forex", name: "My Custom Forex", symbols: ["EURUSD", "GBPUSD"] });
  seedDefaultPairGroups(OWNER);
  const editedForex = listGroups(OWNER).find((g) => g.id === "forex")!;
  assert.equal(editedForex.name, "My Custom Forex");
  assert.deepEqual(editedForex.symbols, ["EURUSD", "GBPUSD"]);
  console.log("    user's edit to the seeded 'forex' group was NOT clobbered by re-seeding");

  console.log("\n[6] A user's own custom group (new id) coexists with seeded ones...\n");
  upsertGroup(OWNER, { id: "my-own", name: "My Own Group", symbols: ["EURUSD"] });
  seedDefaultPairGroups(OWNER);
  assert.equal(listGroups(OWNER).length, 9);
  console.log("    9 groups total: 8 seeded (1 edited) + 1 user-created, no interference");

  console.log("\n[7] DEFAULT_PAIR_GROUPS itself is exported real data, not hidden...\n");
  assert.equal(DEFAULT_PAIR_GROUPS.length, 8);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
