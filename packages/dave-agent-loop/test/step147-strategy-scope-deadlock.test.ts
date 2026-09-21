import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The real, live bug the trader caught by refusing to accept my explanation.
 *
 * I pulled Railway logs, saw 41 consecutive SKIPs with detailed, varied, intelligent-sounding
 * reasoning, and reported it as healthy risk management on a small account. The trader said: "It's
 * a lie the decision is always none / Why? / There is bug" -- and was right.
 *
 * The account's active HTF Top-Down Pullback strategy skill opens with "Read in this order, every
 * time, before any entry: D1 -> H4 -> H1 -> M15 -> M5". The analysis scope had been narrowed to
 * exclude D1 (a correct response to "I'm not a day trader" that nobody checked the consequences
 * of). autonomous-tick.ts tells the model to follow the active skill exactly and NOT to supplement
 * it with other timeframes. So step one of the only strategy in force required data the system had
 * stopped fetching, and the loop stood down forever -- eleven of those 41 cycles carrying the
 * identical sentence "no valid setup under the top-down flow". No error, no exception, nothing in
 * any log saying "this cannot work". It read exactly like caution.
 *
 * Two things are proven here: D1 is back (the trader's call, made with the deadlock in front of
 * them), and the whole CLASS of failure now announces itself instead of hiding as caution.
 */

const workDir = mkdtempSync(join(tmpdir(), "dave-step147-"));
process.env.DAVE_DATA_ROOT = workDir;

const { ALL_ANALYSIS_TIMEFRAMES, isAnalysisScopeSufficientFor, setCustomTimeframes, resetAnalysisConfigToAll } = await import("../../dave-trading/src/analysis-config.js");

const OWNER = "trader-1";
const repoRoot = join(import.meta.dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(repoRoot, p), "utf8");

console.log("=== The strategy/scope deadlock that produced 41 silent SKIPs ===\n");

console.log("[1] D1 is genuinely fetched again -- the strategy's bias anchor exists...\n");
assert.ok((ALL_ANALYSIS_TIMEFRAMES as readonly string[]).includes("D1"), "D1 must be in the real suite");
assert.deepEqual([...ALL_ANALYSIS_TIMEFRAMES], ["D1", "H4", "H1", "M15", "M5", "M3", "M1"], "ordered high-to-low, matching the strategy's own top-down language");
console.log(`    confirmed: ${ALL_ANALYSIS_TIMEFRAMES.join(", ")}`);

console.log("\n[2] The trader's REAL strategy text is now satisfiable...\n");
const skill = read("docs/skill-installers/htf-top-down-pullback-strategy.jsonl");
assert.match(skill, /D1\s*->\s*H4\s*->\s*H1\s*->\s*M15\s*->\s*M5/, "fixture check: the real skill genuinely demands the D1-anchored flow");
resetAnalysisConfigToAll(OWNER);
const ok = isAnalysisScopeSufficientFor(OWNER, skill);
assert.equal(ok.sufficient, true, `the real installed strategy must now be satisfiable; missing: ${ok.missing.join(", ")}`);
console.log("    confirmed: the real HTF Top-Down Pullback skill is satisfiable against the real scope");

console.log("\n[3] THE BUG, reproduced exactly: drop D1 and the same strategy becomes impossible...\n");
setCustomTimeframes(OWNER, ["H4", "H1", "M15", "M5", "M3", "M1"]); // the exact scope that deadlocked
const broken = isAnalysisScopeSufficientFor(OWNER, skill);
assert.equal(broken.sufficient, false, "this is the live configuration that produced 41 silent SKIPs");
assert.deepEqual(broken.missing, ["D1"], "and D1 is precisely what was missing");
console.log(`    confirmed: reproduced -- scope ${broken.active.join(",")} cannot satisfy a strategy needing ${broken.missing.join(",")}`);

console.log("\n[4] It no longer hides: the tick warns instead of standing down forever...\n");
const tickSrc = read("packages/dave-agent-loop/src/autonomous-tick.ts");
assert.ok(tickSrc.includes("scopeWarningFor(userId, activeSkill.content)"), "the tick must run the check on the ACTIVE skill every cycle");
assert.ok(tickSrc.includes("SCOPE WARNING:"), "the warning must reach the model, not just the log");
assert.ok(tickSrc.includes("no amount of waiting will produce the missing data"), "the model must be told the data is never coming");
assert.ok(tickSrc.includes("waiting for a timeframe that will never arrive"), "…in the plainest possible terms");
assert.match(tickSrc, /Do NOT stand down cycle after cycle/, "…and told explicitly not to repeat the exact failure that happened");
assert.match(tickSrc, /use ASK to tell the user/, "…with a real escalation path to the trader");
assert.ok(tickSrc.includes("console.warn"), "…and it must be visible in the logs, where this was invisible for hours");
console.log("    confirmed: warns the model, offers ASK, and logs it loudly");

console.log("\n[5] The warning is silent when the scope is genuinely fine -- no crying wolf...\n");
resetAnalysisConfigToAll(OWNER);
assert.equal(isAnalysisScopeSufficientFor(OWNER, skill).missing.length, 0);
assert.equal(isAnalysisScopeSufficientFor(OWNER, "Trade pullbacks on M15 with M5 confirmation.").sufficient, true, "a skill inside the scope must never warn");
console.log("    confirmed: no warning when the strategy genuinely fits");

console.log("\n[6] It catches the whole CLASS, not just D1 -- including data that can NEVER exist...\n");
resetAnalysisConfigToAll(OWNER);
const weekly = isAnalysisScopeSufficientFor(OWNER, "Anchor bias on the W1 close, then drop to H1.");
assert.equal(weekly.sufficient, false, "W1 is fetched by nothing -- a strategy demanding it is unsatisfiable at any scope");
assert.deepEqual(weekly.missing, ["W1"]);
setCustomTimeframes(OWNER, ["M5"]); // the other real scope this account has been stuck in
const m5only = isAnalysisScopeSufficientFor(OWNER, skill);
assert.deepEqual(m5only.missing, ["D1", "H4", "H1", "M15"], "an M5-only scope must report every missing rung, not just the first");
console.log(`    confirmed: W1 caught; M5-only scope reports all 4 missing rungs`);

console.log("\n[7] A SEQUENCE rung is fatal; an 'or' ALTERNATIVE is not -- found on the real skill...\n");
// Running this against the trader's own installed skill (not a fixture) flagged M30, from
// "A structure shift is a CHoCH on M5, M15, or M30". M5 and M15 are both fetched, so that rule is
// satisfiable and warning about it would be wrong -- and a warning that fires every cycle on a
// healthy strategy trains everyone to ignore it, which is how the original bug stayed invisible.
resetAnalysisConfigToAll(OWNER);
assert.equal(isAnalysisScopeSufficientFor(OWNER, "A structure shift is a CHoCH on M5, M15, or M30.").sufficient, true, "an 'or' option we can't fetch must NOT warn when a listed alternative is available");
assert.deepEqual(isAnalysisScopeSufficientFor(OWNER, "Confirm on M30 or W1 only.").missing, ["W1", "M30"], "…but an 'or' where we can fetch NEITHER option is still a real problem");
assert.deepEqual(isAnalysisScopeSufficientFor(OWNER, "Read in this order: W1 -> H4 -> H1.").missing, ["W1"], "a SEQUENCE rung stays fatal even though its neighbours are all in scope -- this is the real bug's shape");
console.log("    confirmed: 'or' alternatives forgiven, '->' sequence rungs still caught");

console.log("\n[8] Token matching is exact -- M1 is never mistaken for M15...\n");
resetAnalysisConfigToAll(OWNER);
setCustomTimeframes(OWNER, ["M15"]);
const m1 = isAnalysisScopeSufficientFor(OWNER, "Use the M1 chart only.");
assert.deepEqual(m1.missing, ["M1"], "M1 must be detected as missing even though M15 contains the characters 'M1'");
setCustomTimeframes(OWNER, ["M1"]);
const m15 = isAnalysisScopeSufficientFor(OWNER, "Use the M15 chart only.");
assert.deepEqual(m15.missing, ["M15"], "…and M15 must not be satisfied by M1 being present");
console.log("    confirmed: M1 vs M15 never confused in either direction");

console.log("\n[9] The EA was never the problem -- it has always supported D1...\n");
const ea = read("ea/DaveEA.mq5");
assert.match(ea, /if\(tf == "D1"\)\s*return PERIOD_D1;/, "the EA already maps D1 -- recompiling it would have changed nothing");
console.log("    confirmed: EA maps D1 already; the gap was only in what the bot ASKED for");

console.log("\n[10] The 7-timeframe suite still clears one EA poll -- no latency regression...\n");
const webhook = read("packages/dave-ea-bridge/src/ea-webhook.ts");
const cap = Number(/MAX_ANALYZE_COMMANDS_PER_POLL = (\d+)/.exec(webhook)?.[1]);
assert.ok(cap >= ALL_ANALYSIS_TIMEFRAMES.length, `the per-poll cap (${cap}) must fit one symbol's full ${ALL_ANALYSIS_TIMEFRAMES.length}-timeframe suite, or the last one overflows into an extra heartbeat`);
console.log(`    confirmed: cap ${cap} >= ${ALL_ANALYSIS_TIMEFRAMES.length} timeframes -- a single symbol's suite fits one poll`);

console.log("\n[11] Narrowing the scope now warns about exactly this...\n");
const settings = read("packages/dave-workers/src/settings-tool.ts");
assert.match(settings, /D1\/H4\/H1\/M15\/M5\/M3\/M1/, "the tool must offer the real list");
assert.match(settings, /silent, permanent stand-down/, "…and warn that dropping a required timeframe fails silently");
console.log("    confirmed: the settings tool names the risk at the point of the decision");

console.log("\n=== ALL ASSERTIONS PASSED ===");
process.exit(0);
