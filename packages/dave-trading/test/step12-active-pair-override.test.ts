import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertGroup, setActiveGroup, setActivePairSymbol, clearActivePairSymbol, getActiveGroupInfo } from "../src/pair-groups.js";
import { findSetup } from "../src/find-setup.js";
import type { AnalysisSource } from "../src/analysis-source.js";

// Item 5 (DAVEMA retirement): a minimal stand-in for the real EA-backed AnalysisSource
// dave-ea-bridge provides in production -- this test only cares about which symbols get
// scanned, not the real confluence data.
const stubAnalysis: AnalysisSource = { get: async () => ({ score: 0, direction: "neutral" }) };

/**
 * Real proof for the user's ask: "add active pair so incase a user doesn't want to use a group of
 * pair it can select a pair the bot can focus only." A real, persisted single-symbol override that
 * takes priority over the active pair group everywhere real scanning actually happens (find_setup
 * here; the same effectiveSymbols field is what any other real consumer must use too).
 */

console.log("=== Real proof: a single-pair focus genuinely overrides the active group everywhere ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-active-pair-"));
process.chdir(workDir);
const USER_ID = "user-active-pair-1";

try {
  console.log("[1] With a real active group and no override, effectiveSymbols is the whole group...\n");
  upsertGroup(USER_ID, { id: "forex", name: "Forex", symbols: ["EURUSD", "GBPUSD", "USDJPY"] });
  setActiveGroup(USER_ID, "forex");
  let info = getActiveGroupInfo(USER_ID);
  assert.deepEqual(info.effectiveSymbols, ["EURUSD", "GBPUSD", "USDJPY"]);
  assert.equal(info.activePairSymbol, null);
  console.log(`    real effectiveSymbols (no override): ${JSON.stringify(info.effectiveSymbols)}`);

  console.log("\n[2] Setting a single-pair focus genuinely overrides the group's symbol list...\n");
  setActivePairSymbol(USER_ID, "xauusd"); // lowercase input -- real normalization
  info = getActiveGroupInfo(USER_ID);
  assert.equal(info.activePairSymbol, "XAUUSD");
  assert.deepEqual(info.effectiveSymbols, ["XAUUSD"], "the real override must replace the group's symbols entirely, not add to them");
  console.log(`    real effectiveSymbols (focused on XAUUSD): ${JSON.stringify(info.effectiveSymbols)}`);

  console.log("\n[3] find_setup genuinely scans ONLY the focused pair, not the whole group...\n");
  const result = await findSetup(USER_ID, stubAnalysis, "H1");
  assert.deepEqual(result.rows.map((r) => r.symbol), ["XAUUSD"], "find_setup must genuinely honor the real single-pair override");
  assert.equal(result.groupName, "XAUUSD (single pair)");
  console.log(`    real find_setup scanned: ${JSON.stringify(result.rows.map((r) => r.symbol))}, groupName: "${result.groupName}"`);

  console.log("\n[4] Clearing the focus genuinely goes back to the whole active group...\n");
  clearActivePairSymbol(USER_ID);
  info = getActiveGroupInfo(USER_ID);
  assert.equal(info.activePairSymbol, null);
  assert.deepEqual(info.effectiveSymbols, ["EURUSD", "GBPUSD", "USDJPY"]);
  console.log(`    real effectiveSymbols after clearing: ${JSON.stringify(info.effectiveSymbols)}`);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
