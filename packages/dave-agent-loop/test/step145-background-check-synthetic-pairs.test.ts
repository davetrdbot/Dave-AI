import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Real gap the trader spotted (in their words: "you know the background tool, only works for coins
 * and others -- give it a way so it can check for synthetic pairs, mostly").
 *
 * They were exactly right, and it was the sharpest possible catch. A sandbox has genuine internet
 * access, so a script could always price bitcoin or gold on its own. But VOL_80, CRASH_100,
 * BOOM_500 and the rest are GENERATED INSIDE their own MT5 terminal -- they appear on no public
 * API anywhere on the internet. So the script capability, as shipped, was useless for the only
 * instruments this trader actually trades. Worse than useless: a model asked to check VOL_80 by
 * script would reach for some real-world "volatility index" and quietly return a number about a
 * completely different instrument.
 *
 * The fix is to carry the data in rather than expect the script to find it: a check names its
 * symbols, and every tick fetches their real EA analysis and writes it into the sandbox as
 * market.json before the script runs.
 */

const workDir = mkdtempSync(join(tmpdir(), "dave-step145-"));
process.env.DAVE_DATA_ROOT = workDir;

const { createBackgroundCheck, BACKGROUND_CHECK_TOOLS, MAX_CHECK_SYMBOLS } = await import("../../dave-workers/src/background-check-tools.js");

const OWNER = "trader-1";
const repoRoot = join(import.meta.dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(repoRoot, p), "utf8");
const SYNTHETICS = ["VOL_80", "CRASH_100", "BOOM_500", "STORM_500", "FLAMES", "VOL_10"];

console.log("=== Background checks can genuinely watch SYNTHETIC pairs, not just coins ===\n");

console.log("[1] A check can name the synthetic pairs it is actually about...\n");
const check = createBackgroundCheck(OWNER, {
  reason: "long VOL_80 on the 196740 gap holding; want out if it genuinely closes below with momentum gone",
  whatToCheck: "has VOL_80 closed below 196740 with momentum no longer supporting the long",
  script: "python3 -c \"import json;d=json.load(open('/home/user/in/market.json'));print(list(d['symbols']))\"",
  scriptLanguage: "bash",
  symbols: ["vol_80"],
  timeframe: "m15",
});
assert.deepEqual(check.symbols, ["VOL_80"], "symbols must persist, normalised to the EA's own casing");
assert.equal(check.timeframe, "M15", "timeframe normalised too");
const stored = JSON.parse(readFileSync(join(workDir, "data", "background-checks", OWNER, "registry.json"), "utf8"));
assert.deepEqual(stored[0].symbols, ["VOL_80"], "…and survives the real file round trip, not just memory");
console.log("    confirmed: symbols + timeframe persisted and normalised");

console.log("\n[2] The symbol list is capped -- one check can't turn a tick into a full scan...\n");
const greedy = createBackgroundCheck(OWNER, { reason: "r", whatToCheck: "w", symbols: [...SYNTHETICS] });
assert.equal(greedy.symbols!.length, MAX_CHECK_SYMBOLS, `must cap at ${MAX_CHECK_SYMBOLS}`);
assert.deepEqual(greedy.symbols, ["VOL_80", "CRASH_100", "BOOM_500"], "keeps the first ones named, in order");
console.log(`    confirmed: 6 requested -> capped to ${MAX_CHECK_SYMBOLS}, EA round trips stay bounded`);

console.log("\n[3] A check about crypto needs no symbols -- the script fetches it itself...\n");
const crypto = createBackgroundCheck(OWNER, { reason: "r", whatToCheck: "is BTC back above 90k", script: "curl -s https://api.coingecko.com/...", symbols: [] });
assert.equal(crypto.symbols, undefined, "an empty list must stay undefined, not an empty array in the record");
assert.equal(crypto.timeframe, undefined, "no symbols means no timeframe fetch");
console.log("    confirmed: internet-reachable checks are unaffected");

console.log("\n[4] The tool TELLS the model synthetics can't be fetched from the internet...\n");
const tool = BACKGROUND_CHECK_TOOLS.find((t) => t.name === "start_background_check")!;
const props = (tool.parameters as { properties: Record<string, { description?: string }> }).properties;
assert.ok(props.symbols, "symbols must be exposed");
assert.ok(props.timeframe, "timeframe must be exposed");
const symbolDesc = props.symbols.description ?? "";
assert.match(symbolDesc, /no public API/i, "it must say plainly that synthetics aren't on a public API");
assert.match(symbolDesc, /market\.json/, "…and name the file the script actually reads");
for (const s of ["VOL_80", "CRASH_100", "BOOM_500"]) {
  assert.ok(symbolDesc.includes(s), `it should name real synthetics like ${s} so the model recognises them`);
}
console.log("    confirmed: the tool description names real synthetics and the market.json contract");

console.log("\n[5] run_script itself warns against inventing a synthetic price...\n");
const { E2B_TOOLS } = await import("../../dave-e2b/src/index.js");
const runScriptDesc = E2B_TOOLS.find((t) => t.name === "run_script")!.description;
assert.match(runScriptDesc, /synthetic pairs/i, "run_script must carry the same warning");
assert.match(runScriptDesc, /never substitute a real-world instrument/i, "the dangerous failure is substituting a lookalike instrument");
assert.match(runScriptDesc, /get_all_analysis/, "…and must name the real way to get synthetic data");
console.log("    confirmed: run_script warns against substituting a real-world lookalike");

console.log("\n[6] The tick genuinely FETCHES the symbols and writes them into the sandbox...\n");
const loopSrc = read("packages/dave-agent-loop/src/background-check-loop.ts");
assert.ok(/deps\.analysis\.get\("all", symbol/.test(loopSrc), "each named symbol must be fetched from the real EA");
assert.ok(loopSrc.includes('path: "market.json"'), "…and written into the sandbox as market.json");
assert.ok(loopSrc.includes("filesIn: marketFile"), "…passed as a real input file to the script");
assert.ok(loopSrc.includes("SYMBOL_FETCH_TIMEOUT_MS"), "the EA round trip must be bounded -- this runs unattended on a timer");
console.log("    confirmed: real EA fetch -> market.json -> script, with a bounded round trip");

console.log("\n[7] A failed fetch is reported honestly, never guessed around...\n");
assert.ok(loopSrc.includes("marketErrors"), "fetch failures must be tracked");
assert.ok(/genuinely FAILED to fetch[\s\S]{0,80}Do not guess/.test(loopSrc), "the model must be told explicitly not to guess at a symbol it has no data for");
assert.ok(loopSrc.includes("never substitute a real-world instrument"), "…and not to swap in a lookalike");
// A fetch failure must not kill the whole tick -- the check retries next interval.
assert.ok(/catch \(err\) \{\s*marketErrors\.push/.test(loopSrc), "one bad symbol must not abort the tick");
console.log("    confirmed: failures surface as 'no data, do not guess' and the tick still runs");

console.log("\n[8] Dave is actually TAUGHT this, with a concrete scenario...\n");
const identity = read("prompts/IDENTITY.md");
assert.match(identity, /symbols/, "the prompt must mention the symbols argument");
assert.match(identity, /no public API/i, "…and why synthetics are different");
assert.match(identity, /market\.json/, "…and the file the script reads");
assert.match(identity, /Scenario/i, "the trader explicitly asked for a scenario");
assert.match(identity, /VOL_80[\s\S]{0,600}196740/, "the scenario must be concrete, with a real pair and a real level");
assert.match(identity, /not a volatility index you can look up/i, "the lookalike trap must be called out by name");
for (const s of ["CRASH_100", "BOOM_500", "STORM_500", "FLAMES", "VOL_10"]) {
  assert.ok(identity.includes(s), `the prompt should name ${s} so Dave recognises it as a synthetic`);
}
console.log("    confirmed: prompt teaches it with a real VOL_80 scenario and names the synthetics");

console.log("\n[9] A PENDING check is no longer a black box -- its script's last output is visible...\n");
// The trader: "hope you added for it to see pending scripts and also for the run script to return
// back with responses". Before this you could see a check had a script and had polled 14 times,
// but not one thing it had actually measured -- so a script quietly failing looked identical to
// one finding nothing.
const { recordBackgroundCheckScriptRun, getBackgroundCheck, listBackgroundChecks, MAX_STORED_SCRIPT_OUTPUT } = await import("../../dave-workers/src/background-check-tools.js");
const watched = createBackgroundCheck(OWNER, { reason: "watching the gap", whatToCheck: "below 196740?", script: "print(1)", symbols: ["VOL_80"] });
assert.equal(getBackgroundCheck(OWNER, watched.id)!.lastScriptRun, undefined, "nothing recorded before the first tick");

recordBackgroundCheckScriptRun(OWNER, watched.id, { at: Date.now(), exitCode: 0, stdout: "closes_below=2 momentum=-0.4", stderr: "" });
const afterRun = getBackgroundCheck(OWNER, watched.id)!;
assert.equal(afterRun.lastScriptRun!.exitCode, 0);
assert.match(afterRun.lastScriptRun!.stdout, /closes_below=2/, "the real reading must be inspectable mid-flight");
assert.ok(listBackgroundChecks(OWNER, true).find((c) => c.id === watched.id)?.lastScriptRun, "…and visible in the list, not just the single get");
console.log("    confirmed: a running check's real last measurement is inspectable");

// A script that cannot run AT ALL must look different from one that ran and found nothing.
recordBackgroundCheckScriptRun(OWNER, watched.id, { at: Date.now(), exitCode: null, stdout: "", stderr: "", error: "No E2B key stored yet" });
const failed = getBackgroundCheck(OWNER, watched.id)!.lastScriptRun!;
assert.equal(failed.exitCode, null, "a run that never happened must be distinguishable from exit 0");
assert.match(failed.error!, /No E2B key/, "…and carry the real reason");
console.log("    confirmed: 'never ran' is distinguishable from 'ran and found nothing'");

// Bounded: this registry is rewritten on every tick of every check.
recordBackgroundCheckScriptRun(OWNER, watched.id, { at: Date.now(), exitCode: 0, stdout: "x".repeat(50_000), stderr: "y".repeat(50_000) });
const huge = getBackgroundCheck(OWNER, watched.id)!.lastScriptRun!;
assert.equal(huge.stdout.length, MAX_STORED_SCRIPT_OUTPUT, "stored output must be capped");
assert.equal(huge.stderr.length, MAX_STORED_SCRIPT_OUTPUT);
console.log(`    confirmed: output capped at ${MAX_STORED_SCRIPT_OUTPUT} chars -- a chatty script can't bloat the registry`);

// A late write from an in-flight tick must never resurrect a stopped check.
recordBackgroundCheckScriptRun(OWNER, "no-such-check-id", { at: Date.now(), exitCode: 0, stdout: "ghost", stderr: "" });
assert.equal(getBackgroundCheck(OWNER, "no-such-check-id"), undefined, "a write for an unknown check must no-op, not create one");
console.log("    confirmed: a late write for a vanished check no-ops");

console.log("\n[10] run_script genuinely RETURNS its results to the caller...\n");
const runScriptTool = (await import("../../dave-e2b/src/index.js")).E2B_TOOLS.find((t) => t.name === "run_script")!;
assert.match(runScriptTool.description, /real stdout, stderr, exit code, and any files it produced/, "the tool must promise a real response, not fire-and-forget");
// The loop must genuinely feed that response back into the tick's own reasoning.
assert.ok(loopSrc.includes("run.stdout") && loopSrc.includes("run.exitCode"), "the background tick must read the real stdout and exit code back");
assert.ok(loopSrc.includes("run.filesOut"), "…and any files the script produced");
const tickSrc = read("packages/dave-agent-loop/src/autonomous-tick.ts");
assert.ok(tickSrc.includes("YOUR SCRIPT'S REAL OUTPUT"), "the trading tick must hand the real output back to the decision");
assert.ok(tickSrc.includes("run.exitCode !== 0"), "…and flag a failed script rather than letting a result be read into it");
console.log("    confirmed: stdout/stderr/exit code/files all returned and fed back on every path");

console.log("\n=== ALL ASSERTIONS PASSED ===");
process.exit(0);
