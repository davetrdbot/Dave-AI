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
 * available pairs in the same group for an opportunity"), reinforced by a later live bug report
 * (user: "it doesn't extract info from the market watch only the pair I add to do big check"):
 * a single-pair FOCUS (setActivePairSymbol) used to make hunt mode scan ONLY that one symbol
 * whenever it scored well enough -- which live reads exactly like "the bot only ever checks the
 * one pair I added," even though a whole group of real synthetic pairs was configured. Hunt mode
 * must always scan the WHOLE real active group -- a single-pair focus never narrows the
 * autonomous hunt loop (it still exists for find_setup's explicit "check just this one" case) --
 * and supports excluding already-declined symbols for a genuine "Find Another" re-hunt.
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

  console.log("[1] No single-pair focus -- hunt mode scans the whole real active group...\n");
  const weakGroup = scoredAnalysis({ EURUSD: 20, GBPUSD: 15, USDJPY: 10 });
  const noFocusResult = await huntForSetup(USER, weakGroup, "H1");
  assert.equal(noFocusResult.huntModeActivated, true, "scanning a multi-symbol group is real hunt-mode coverage");
  assert.equal(noFocusResult.rows.length, 3);
  console.log(`    real result: huntModeActivated=${noFocusResult.huntModeActivated}, bestSetup=${JSON.stringify(noFocusResult.bestSetup)}`);

  console.log("\n[2] Single-pair focus on a WEAK pair -- hunt mode still scans the WHOLE real active group, not just the focused pair...\n");
  setActivePairSymbol(USER, "eurusd");
  const mixedScores = scoredAnalysis({ EURUSD: 25, GBPUSD: 82, USDJPY: 40 });
  const huntResult = await huntForSetup(USER, mixedScores, "H1");
  assert.equal(huntResult.huntModeActivated, true, "must genuinely activate hunt mode across the whole group");
  assert.deepEqual(huntResult.rows.map((r) => r.symbol).sort(), ["EURUSD", "GBPUSD", "USDJPY"], "must genuinely scan the WHOLE group, not just the focused pair");
  assert.equal(huntResult.bestSetup?.symbol, "GBPUSD", "must genuinely pick the real best candidate across the group");
  assert.ok(huntResult.bestSetup!.score >= HUNT_MODE_MIN_SCORE);
  console.log(`    real hunt result: scanned ${huntResult.rows.map((r) => r.symbol).join(", ")} -> best: ${huntResult.bestSetup?.symbol} (score ${huntResult.bestSetup?.score})`);

  console.log("\n[3] Single-pair focus on a GOOD pair -- hunt mode STILL scans the whole real group (a real bug report: 'it doesn't extract info from the market watch only the pair I add')...\n");
  const goodFocusScores = scoredAnalysis({ EURUSD: 88, GBPUSD: 30, USDJPY: 20 });
  const noNeedResult = await huntForSetup(USER, goodFocusScores, "H1");
  assert.equal(noNeedResult.huntModeActivated, true, "a single-pair focus must never narrow the real autonomous hunt loop");
  assert.equal(noNeedResult.rows.length, 3, "must genuinely scan every real symbol in the group, not just the focused pair");
  assert.equal(noNeedResult.bestSetup?.symbol, "EURUSD", "the genuinely best real candidate still wins even though the focused pair happens to be it");
  console.log(`    real result: huntModeActivated=${noNeedResult.huntModeActivated}, scanned [${noNeedResult.rows.map((r) => r.symbol).join(", ")}]`);

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
