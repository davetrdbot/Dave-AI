import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertGroup, setActiveGroup, setActivePairSymbol } from "../src/pair-groups.js";
import { huntForSetup, HUNT_MODE_MIN_SCORE } from "../src/find-setup.js";
import type { AnalysisSource } from "../src/analysis-source.js";

/**
 * Real proof for items 2 & 6 (user: "if no clean setup exists on the currently configured/
 * active pair, Dave does NOT just stop -- it activates 'Hunt Mode,' actively scanning OTHER
 * available pairs in the same group for an opportunity"). Root cause confirmed: findSetup()
 * already scanned the whole group by default, but when a single-pair FOCUS was active
 * (setActivePairSymbol), it only ever looked at that one pair -- a weak setup there just... quietly
 * stopped, with nothing broader ever tried. huntForSetup() is the real fix: it broadens to the
 * rest of the real active group when the focused pair doesn't clear a real minimum score, and
 * supports excluding already-declined symbols for a genuine "Find Another" re-hunt.
 */

console.log("=== Real proof: hunt mode genuinely broadens beyond a single-pair focus ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-hunt-mode-"));
process.chdir(workDir);

function scoredAnalysis(scores: Record<string, number>): AnalysisSource {
  return {
    get: async (_endpoint, symbol) => ({ score: scores[symbol] ?? 10, direction: (scores[symbol] ?? 10) >= 50 ? "buy" : "sell" }),
  };
}

async function main() {
  const USER = "user-hunt-1";
  upsertGroup(USER, { id: "majors", name: "Majors", symbols: ["EURUSD", "GBPUSD", "USDJPY"] });
  setActiveGroup(USER, "majors");

  console.log("[1] No single-pair focus, whole group already scanned, nothing above the real floor -- hunt mode does NOT falsely claim it broadened anything...\n");
  const weakGroup = scoredAnalysis({ EURUSD: 20, GBPUSD: 15, USDJPY: 10 });
  const noFocusResult = await huntForSetup(USER, weakGroup, "H1");
  assert.equal(noFocusResult.huntModeActivated, false, "a real whole-group scan with no exclusions is not 'hunt mode broadening' -- it's just the normal scan");
  assert.equal(noFocusResult.rows.length, 3);
  console.log(`    real result: huntModeActivated=${noFocusResult.huntModeActivated}, bestSetup=${JSON.stringify(noFocusResult.bestSetup)}`);

  console.log("\n[2] Single-pair focus on a WEAK pair -- hunt mode genuinely broadens to the rest of the real active group...\n");
  setActivePairSymbol(USER, "eurusd");
  const mixedScores = scoredAnalysis({ EURUSD: 25, GBPUSD: 82, USDJPY: 40 });
  const huntResult = await huntForSetup(USER, mixedScores, "H1");
  assert.equal(huntResult.huntModeActivated, true, "must genuinely activate hunt mode -- the focused pair was below the real floor");
  assert.deepEqual(huntResult.rows.map((r) => r.symbol).sort(), ["EURUSD", "GBPUSD", "USDJPY"], "must genuinely scan the WHOLE group, not just the focused pair");
  assert.equal(huntResult.bestSetup?.symbol, "GBPUSD", "must genuinely pick the real best candidate across the broadened group");
  assert.ok(huntResult.bestSetup!.score >= HUNT_MODE_MIN_SCORE);
  console.log(`    real hunt result: scanned ${huntResult.rows.map((r) => r.symbol).join(", ")} -> best: ${huntResult.bestSetup?.symbol} (score ${huntResult.bestSetup?.score})`);

  console.log("\n[3] Single-pair focus on a GOOD pair -- hunt mode does NOT broaden unnecessarily, uses the focused pair...\n");
  const goodFocusScores = scoredAnalysis({ EURUSD: 88, GBPUSD: 30, USDJPY: 20 });
  const noNeedResult = await huntForSetup(USER, goodFocusScores, "H1");
  assert.equal(noNeedResult.huntModeActivated, false, "a genuinely good focused pair must not trigger a pointless broaden");
  assert.equal(noNeedResult.rows.length, 1, "must stay scoped to the single focused pair when it's already good");
  assert.equal(noNeedResult.bestSetup?.symbol, "EURUSD");
  console.log(`    real result: huntModeActivated=${noNeedResult.huntModeActivated}, scanned only [${noNeedResult.rows.map((r) => r.symbol).join(", ")}]`);

  console.log("\n[4] 'Find Another': excluding the just-declined symbol genuinely re-hunts and finds the next real candidate...\n");
  const declineResult = await huntForSetup(USER, mixedScores, "H1", { excludeSymbols: ["GBPUSD"] });
  assert.equal(declineResult.bestSetup?.symbol, "USDJPY", "excluding the declined top pick must genuinely surface the real next-best candidate");
  assert.notEqual(declineResult.bestSetup?.symbol, "GBPUSD", "the declined symbol must never be re-proposed");
  console.log(`    real re-hunt after declining GBPUSD: next candidate = ${declineResult.bestSetup?.symbol} (score ${declineResult.bestSetup?.score})`);

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
