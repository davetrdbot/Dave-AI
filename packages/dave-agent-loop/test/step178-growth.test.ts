import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider, CompletionRequest, CompletionResult } from "@dave/brain";
import {
  scoreAgainstGoals,
  DEFAULT_GOALS,
  getStrategyState,
  validateChange,
  getMinRiskReward,
  setMinRiskReward,
  listNeurons,
  learnFact,
  reinforceFact,
  growthContextBlock,
  isAvoidedByStrategy,
} from "@dave/trading";
import { runGrowthReflection, growthStatus } from "../src/growth-reflection.js";
import { activityAfter } from "../src/activity-bus.js";

/**
 * The trader: "focus on the self improvement and give it what success and failure is" -- and the
 * pictures: change one variable at a time; Outcome -> Hypothesis -> Test -> Revise.
 */
console.log("=== Step 178: self-improvement loop + brain neurons ===\n");
const workDir = mkdtempSync(join(tmpdir(), "dave-growth-"));
process.chdir(workDir);
process.env.DAVE_DATA_ROOT = workDir;
const U = "grower";

const DAY = 86_400_000;
const T0 = Date.now() - 20 * DAY;
let ticket = 1000;
const history: { ticket: string; symbol: string; side: string; pnl: number; reason: string; closedAt: number }[] = [];
function close(pnl: number, at: number, symbol = "XAUUSD") {
  history.push({ ticket: String(ticket++), symbol, side: "buy", pnl, reason: pnl > 0 ? "tp" : "sl", closedAt: at });
  mkdirSync(join(workDir, "data", "trade-events", U), { recursive: true });
  writeFileSync(join(workDir, "data", "trade-events", U, "closed-trades.json"), JSON.stringify(history));
}
mkdirSync(join(workDir, "data", "ea-bridge", U), { recursive: true });
writeFileSync(join(workDir, "data", "ea-bridge", U, "account-snapshot.json"), JSON.stringify({ account: "1", balance: 1000, equity: 1000 }));

console.log("[1] Scoring: failure limits win over everything");
{
  const good = [20, -10, 25, -10, 30, 15].map((p, i) => ({ pnl: p, closedAt: T0 + i * DAY }));
  const s = scoreAgainstGoals(good, 1070, DEFAULT_GOALS, T0 + 7 * DAY);
  assert.ok(s.score > 0, `good run scores positive (${s.score})`);
  assert.notEqual(s.verdict, "failure");
  const streak = [-5, -5, -5, -5, -5, 40].map((p, i) => ({ pnl: p, closedAt: T0 + i * DAY }));
  const f = scoreAgainstGoals(streak, 1015, DEFAULT_GOALS, T0 + 7 * DAY);
  assert.equal(f.verdict, "failure", "5 losses in a row = failure even though net positive");
  assert.ok(f.score <= -0.5);
}
console.log("   ✓\n");

console.log("[2] Dave may only tighten the trader's numbers");
setMinRiskReward(U, 1.5);
const s0 = getStrategyState(U);
assert.equal(s0.floors.minRiskReward, 1.5);
assert.throws(() => validateChange(U, s0, "min_rr", 1.2), /below the trader's own/);
assert.throws(() => validateChange(U, s0, "min_rr", 4), /at most 1/);
assert.deepEqual(validateChange(U, s0, "min_rr", 2), { variable: "min_rr", from: 1.5, to: 2 });
assert.throws(() => validateChange(U, s0, "leverage", 500), /unknown variable/);
console.log("   ✓\n");

console.log("[3] Not enough trades yet -> no reflection, no model call");
let calls = 0;
const replies: Record<string, unknown>[] = [];
const provider: Provider = {
  name: "mock",
  generate: async (req: CompletionRequest): Promise<CompletionResult> => {
    calls++;
    lastPrompt = String(req.messages[1].content);
    return { text: "", provider: "claude", latencyMs: 1, toolCalls: [{ id: `r${calls}`, name: "submit_reflection", arguments: replies.shift() ?? { outcome: "x", diagnosis: "x", hypothesis: "x", variable: "none" } }] };
  },
};
let lastPrompt = "";
for (let i = 0; i < 3; i++) close(i % 2 ? 12 : -8, T0 + i * DAY);
let r = await runGrowthReflection({ userId: U, provider });
assert.equal(calls, 0);
assert.match(r.skipped ?? "", /3\/6 trades/);
console.log(`   ✓ (${r.skipped})\n`);

console.log("[4] A full cycle -> outcome, facts into neurons, ONE change as v02 under test");
for (let i = 3; i < 8; i++) close(i % 3 === 0 ? 15 : -9, T0 + i * DAY);
replies.push({
  outcome: "8 trades, 3 wins, net -21. Losers were all shallow-stop gold buys.",
  diagnosis: "#1000, #1002, #1004 stopped on the first wick -- targets too close for the stop.",
  hypothesis: "If I raise the R:R floor to 2, fewer marginal entries pass and profit factor rises.",
  variable: "min_rr",
  to: 2,
  facts: [
    { neuron: "rsi", text: "XAUUSD M15 RSI under 25 in a downtrend kept falling -- buying it lost 3 of 4.", evidence: "#1000 #1002 #1004" },
    { neuron: "volatility", text: "Gold stops tighter than 1 ATR got wicked out in London open.", evidence: "#1002" },
  ],
});
r = await runGrowthReflection({ userId: U, provider });
assert.equal(calls, 1);
assert.match(lastPrompt, /Success = making 8% a month/, "the goal is in the prompt");
assert.match(lastPrompt, /FAILURE is: a loss bigger than the risk planned/, "per-trade failure definition too");
assert.equal(r.newVersion?.v, 2);
assert.equal(r.newVersion?.status, "testing");
assert.equal(getMinRiskReward(U), 2, "the one change is live");
const rsi = listNeurons(U).find((n) => n.id === "rsi")!;
assert.equal(rsi.facts.length, 1);
assert.equal(r.learned.length, 2);
assert.ok(activityAfter(U, 0, ["background"]).some((e) => e.kind === "growth" && /v02/.test(String(e.data.text))));
console.log(`   ✓\n${r.message}\n`);

console.log("[5] While testing, a forced reflection refuses a second change");
r = await runGrowthReflection({ userId: U, provider, force: true });
assert.equal(calls, 1, "no model call");
assert.match(r.skipped ?? "", /one change at a time/);
assert.equal(growthStatus(U).stage, "test");
console.log("   ✓\n");

console.log("[6] The test cycle does worse -> the change is undone automatically");
const tStart = Date.now() + 1000;
for (let i = 0; i < 6; i++) close(i === 0 ? 5 : -12, tStart + i * 1000);
replies.push({ outcome: "worse", diagnosis: "the floor starved good trades", hypothesis: "a rule instead", variable: "add_rule", to: "No gold buys in the first 15 minutes of the London open.", reinforce: [{ id: rsi.facts[0].id, supports: true }] });
r = await runGrowthReflection({ userId: U, provider, now: tStart + 10_000 });
assert.equal(r.judged?.kept, false, r.judged?.note);
assert.equal(getMinRiskReward(U), 1.5, "back to the trader's value");
const s1 = getStrategyState(U);
assert.equal(s1.versions.find((v) => v.v === 2)?.status, "reverted");
assert.equal(r.newVersion?.v, 3, "and the loop carries on with the next single change");
assert.equal(s1.rules.length, 1);
assert.equal(listNeurons(U).find((n) => n.id === "rsi")!.facts[0].strength, 3, "the RSI fact was reinforced");
console.log(`   ✓ (${r.judged?.note})\n`);

console.log("[7] Brain: duplicates confirm, contradictions fade a fact out");
const again = learnFact(U, "RSI", "XAUUSD M15 RSI under 25 in a downtrend kept falling, buying it lost 3 of 4");
assert.equal(again.isNew, false);
const weak = learnFact(U, "macd", "MACD cross on M1 synthetics is noise", { strength: 1 });
assert.equal(reinforceFact(U, weak.fact.id, false), null, "contradicted to zero -> forgotten");
assert.equal(listNeurons(U).find((n) => n.id === "macd")!.facts.length, 0);
console.log("   ✓\n");

console.log("[8] What Dave sees on every scan");
const block = growthContextBlock(U, growthStatus(U).score)!;
assert.match(block, /YOUR GOAL/);
assert.match(block, /STRATEGY CARD v03 \(testing: new rule/);
assert.match(block, /YOUR RULES \(follow every one\): \[r\w+\] No gold buys/);
assert.match(block, /WHAT YOUR BRAIN HAS LEARNED.*RSI: XAUUSD M15 RSI under 25/);
assert.equal(isAvoidedByStrategy(U, "XAUUSD"), false);
console.log(block.split("\n").map((l) => `   ${l.slice(0, 160)}`).join("\n"));
console.log("   ✓\n");
console.log("All Step 178 checks passed.");
process.exit(0);
