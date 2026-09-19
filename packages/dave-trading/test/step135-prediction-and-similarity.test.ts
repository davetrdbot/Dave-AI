import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workDir = mkdtempSync(join(tmpdir(), "dave-predict-"));
process.env.DAVE_DATA_ROOT = workDir;

const {
  recordExpectation,
  getExpectation,
  recordOutcome,
  findSimilarSetups,
  predictionAccuracySummary,
  listOutcomes,
  InvalidExpectationError,
} = await import("@dave/trading");

/**
 * Self-Awareness spec parts 4 (prediction vs reality) and 5 (similar-trade memory).
 */

const USER = "user-predict-1";

console.log("=== Prediction-vs-reality + similar-trade memory ===\n");

try {
  console.log("[1] Record an expectation before the trade; it's retrievable and validated...\n");
  assert.throws(() => recordExpectation(USER, { ticket: "", symbol: "VOL_80", direction: "buy" } as never), InvalidExpectationError);
  assert.throws(() => recordExpectation(USER, { ticket: "T1", symbol: "VOL_80", direction: "long" } as never), InvalidExpectationError);
  recordExpectation(USER, {
    ticket: "T1",
    symbol: "VOL_80",
    direction: "buy",
    timeframe: "M5",
    setupTags: ["liquidity-sweep", "FVG"],
    expectedTarget: 202910,
    expectedTimeMinutes: 20,
    expectedMaxDrawdownPct: 1.5,
    confidence: 78,
    expectedBehavior: "quick spike off the sweep",
  });
  const exp = getExpectation(USER, "T1");
  assert.equal(exp?.expectedTimeMinutes, 20);
  assert.deepEqual(exp?.setupTags, ["liquidity-sweep", "FVG"]);
  console.log("    confirmed: expectation stored with target/time/drawdown/confidence/behavior");

  console.log("\n[2] On close, the outcome is compared to the expectation and the expectation consumed...\n");
  const outcome = recordOutcome(USER, { ticket: "T1", symbol: "VOL_80", direction: "buy", actual: { durationMinutes: 12, closePnl: 34, worstPnl: -6 } });
  assert.equal(outcome.thesisCorrect, true, "closed in profit -> thesis correct (inferred)");
  assert.equal(outcome.expected?.expectedTimeMinutes, 20, "the outcome carries the original expectation");
  assert.equal(outcome.actual.durationMinutes, 12, "and the actual duration");
  assert.equal(getExpectation(USER, "T1"), undefined, "the expectation is consumed once folded into the outcome");
  console.log("    confirmed: expected 20min/target vs actual 12min/+34, thesis correct, expectation consumed");

  console.log("\n[3] An outcome can be recorded with NO prior expectation (grows the memory anyway)...\n");
  recordOutcome(USER, { ticket: "T2", symbol: "VOL_80", direction: "buy", actual: { durationMinutes: 25, closePnl: -12 } });
  assert.equal(listOutcomes(USER).length, 2);
  assert.equal(listOutcomes(USER).find((o) => o.ticket === "T2")?.thesisCorrect, false, "a loss infers thesis incorrect");
  console.log("    confirmed: a bare close still records an outcome; loss -> thesis incorrect");

  console.log("\n[4] find_similar_setups reports the real hit/fail/avg-time picture...\n");
  // add a few more VOL_80 buys to make the numbers meaningful
  recordOutcome(USER, { ticket: "T3", symbol: "VOL_80", direction: "buy", actual: { durationMinutes: 20, closePnl: 40 } });
  recordOutcome(USER, { ticket: "T4", symbol: "VOL_80", direction: "buy", actual: { durationMinutes: 16, closePnl: 10 } });
  recordOutcome(USER, { ticket: "T5", symbol: "VOL_80", direction: "sell", actual: { durationMinutes: 5, closePnl: 5 } }); // wrong direction
  const sim = findSimilarSetups(USER, { symbol: "VOL_80", direction: "buy" });
  assert.equal(sim.count, 4, "four VOL_80 buys (T1,T2,T3,T4), not the sell");
  assert.equal(sim.hits, 3, "three winners");
  assert.equal(sim.fails, 1, "one loss");
  assert.equal(sim.avgTimeMinutes, Math.round((12 + 25 + 20 + 16) / 4), "average time to outcome across the four");
  console.log(`    confirmed: "${sim.count} similar setups, ${sim.hits} worked and ${sim.fails} failed, avg ${sim.avgTimeMinutes} min"`);

  console.log("\n[5] Tag/timeframe narrowing works but never excludes a record missing that metadata...\n");
  const tagged = findSimilarSetups(USER, { symbol: "VOL_80", direction: "buy", setupTags: ["liquidity-sweep"] });
  assert.ok(tagged.count >= 1, "the tagged T1 still matches on the tag");
  // T2/T3/T4 have no tags -> not excluded by absence, still counted
  assert.equal(tagged.count, 4, "records with no tags are not excluded just because the query has a tag");
  console.log("    confirmed: tags narrow when both sides have them, never punish missing metadata");

  console.log("\n[6] The accuracy summary reflects the record...\n");
  const acc = predictionAccuracySummary(USER);
  assert.equal(acc.total, 5);
  assert.equal(acc.thesisCorrect, 4, "T1,T3,T4,T5 profitable");
  assert.equal(acc.withExpectation, 1, "only T1 had a recorded expectation");
  assert.equal(acc.avgExpectedMinutes, 20);
  assert.equal(acc.avgActualMinutes, 12);
  console.log(`    confirmed: ${acc.total} scored, ${acc.thesisCorrect} correct, expected ${acc.avgExpectedMinutes}m vs actual ${acc.avgActualMinutes}m`);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
