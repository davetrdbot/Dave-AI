import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The trader: "did you fix the risk reward? because the models still tends to follow the risk
 * reward via prompt, so fix that -- it should obey the settings own."
 *
 * They were right, and the cause was subtler than "the gate is missing". The gate was real and
 * genuinely refused bad structures. What was missing is that the model CHOOSING the stop and
 * target was never told what floor it had to clear: the autonomous tick's context carried
 * SL/TP/lot modes, the confidence threshold, open positions and pending orders -- and silently
 * omitted this one setting. So the model fell back on the prompt's general "a target that pays
 * more than its stop risks" (effectively 1:1), produced a structure below the trader's real
 * floor, and got refused after the fact. From the outside that is exactly "it follows the prompt,
 * not my setting".
 *
 * Two of the refusal messages also hardcoded 1:1 language ("risking more than you stand to make"),
 * which is simply false once the floor is raised -- and telling a model something it can see is
 * wrong invites it to argue or to nudge numbers until the sentence stops being untrue.
 */

const workDir = mkdtempSync(join(tmpdir(), "dave-step151-"));
process.env.DAVE_DATA_ROOT = workDir;

const { assessRiskReward, assessRiskRewardForUser, setMinRiskReward, getMinRiskReward } = await import("@dave/trading");
const repoRoot = join(import.meta.dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(repoRoot, p), "utf8");
const OWNER = "trader-1";

const buy = (sl: number, tp: number) => ({ symbol: "VOL_80", type: "buy" as const, lots: 0.02, sl, tp });

console.log("=== Risk:reward obeys the SETTING, and says so ===\n");

console.log("[1] The floor genuinely comes from the setting, not a constant...\n");
{
  setMinRiskReward(OWNER, 2);
  assert.equal(getMinRiskReward(OWNER), 2);
  // Entry 100, stop 90 (risk 10), target 115 (reward 15) -> 1.5:1.
  const at2 = assessRiskRewardForUser(OWNER, buy(90, 115), 100);
  assert.equal(at2.ok, false, "1.5:1 must be refused against a 2:1 floor");
  setMinRiskReward(OWNER, 1);
  const at1 = assessRiskRewardForUser(OWNER, buy(90, 115), 100);
  assert.equal(at1.ok, true, "the identical trade passes at a 1:1 floor -- the SETTING decides");
  console.log("    confirmed: same trade, opposite verdicts, driven purely by the setting");
}

console.log("[2] The refusal names the trader's real floor -- no 1:1 language...\n");
{
  const r = assessRiskReward(buy(90, 115), 100, 2);
  assert.match(r.reason ?? "", /1\.50:1/, "states the achieved ratio");
  assert.match(r.reason ?? "", /below your configured minimum of 2:1/, "…and the configured floor that refused it");
  assert.ok(
    !(r.reason ?? "").includes("Risking more than the trade stands to make"),
    "a 1.5:1 trade does NOT risk more than it makes -- that sentence was factually wrong here"
  );
  console.log(`    confirmed: "${(r.reason ?? "").slice(0, 78)}…"`);
}

console.log("\n[3] …but the break-even warning still appears when it IS true...\n");
{
  const r = assessRiskReward(buy(90, 105), 100, 1); // 0.5:1 -- genuinely risks more than it pays
  assert.match(r.reason ?? "", /0\.50:1/);
  assert.match(r.reason ?? "", /Risking more than the trade stands to make/, "below 1:1 the warning is correct and worth keeping");
  console.log("    confirmed: the warning is kept exactly where it's accurate");
}

console.log("\n[4] THE FIX: the autonomous tick now TELLS the model the floor...\n");
{
  const tick = read("packages/dave-agent-loop/src/autonomous-tick.ts");
  assert.match(tick, /MINIMUM RISK:REWARD: \$\{minRiskReward\}:1/, "the context block must carry the real value");
  assert.match(tick, /HARD GATE/, "…and say plainly that it is enforced, not advice");
  assert.match(tick, /const minRiskReward = getMinRiskReward\(userId\)/, "read fresh per tick, like every other setting");
  // It must reach the model where the numbers are actually chosen, not only in a context header.
  assert.match(tick, /buildDecisionTool\(risk, minRiskReward\)/, "the decision tool must receive it");
  assert.match(tick, /properties\.sl = \{ type: "number", description: `Stop loss price\. \$\{rrNote\}` \}/, "the sl field must state the floor");
  assert.match(tick, /properties\.tp = \{ type: "number", description: `Take profit price\. \$\{rrNote\}` \}/, "…and so must tp");
  console.log("    confirmed: in the context block AND on the sl/tp fields themselves");
}

console.log("\n[5] The model is told NOT to game the number to pass...\n");
{
  const tick = read("packages/dave-agent-loop/src/autonomous-tick.ts");
  assert.match(tick, /Never stretch the target or tighten the stop just to pass this check/, "the obvious workaround must be closed explicitly");
  assert.match(tick, /the ENTRY is in the wrong place -- SKIP/, "…with the correct response named instead");
  console.log("    confirmed: stretching the target to pass is ruled out in the tool description");
}

console.log("\n[6] The tick's own skip message names the floor instead of assuming 1:1...\n");
{
  const tick = read("packages/dave-agent-loop/src/autonomous-tick.ts");
  assert.ok(!tick.includes("I won't place a trade whose stop costs more than its target pays"), "the hardcoded 1:1 sentence must be gone");
  assert.match(tick, /your risk:reward floor is \$\{minRiskReward\}:1 and this structure doesn't clear it/);
  console.log("    confirmed: the skip message reports the trader's real number");
}

console.log("\n[7] The prompt defers to the setting rather than naming a ratio of its own...\n");
{
  const trading = read("prompts/trading.md");
  assert.match(trading, /configured minimum ratio in your live context/, "the prompt must point AT the setting");
  // A literal ratio in the prompt is exactly what would compete with the setting.
  const ratios = trading.match(/\b\d+(\.\d+)?:1\b/g) ?? [];
  assert.deepEqual(ratios, [], `the trading prompt must name no fixed ratio of its own, found: ${ratios.join(", ")}`);
  console.log("    confirmed: no competing hardcoded ratio anywhere in the trading prompt");
}

console.log("\n[8] The aggressive streak is real -- and explicitly not licence to loosen risk...\n");
{
  const trading = read("prompts/trading.md");
  const soul = read("prompts/SOUL.md");
  assert.match(trading, /## Teeth — you don't give up easily/);
  assert.match(trading, /A blank cycle is not a finished job/, "keep hunting");
  assert.match(trading, /Exit on evidence, never on discomfort/, "hold the thesis through noise");
  assert.match(trading, /No revenge sizing/, "…and go again cleanly after a loss");
  assert.match(soul, /You don't give up easily/, "it belongs in the character, not just the trading rules");
  // The load-bearing half: aggression must never reach the risk limits.
  assert.match(trading, /It never means a bigger lot, a wider stop, a stretched target/);
  assert.match(trading, /Push hard against the market; never against your own limits/);
  assert.match(soul, /never into a bigger lot, a wider stop, or a number nudged to slip past your own limits/);
  console.log("    confirmed: relentless on hunting and holding, hard-walled off from the risk gates");
}

console.log("\n=== ALL ASSERTIONS PASSED ===");
process.exit(0);
