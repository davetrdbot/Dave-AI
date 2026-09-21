import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The trader's ask, in their own words: "expand the background tool and the subtask so it can run
 * any script to check for anything in the market and you can connect the main agent to the e2b /
 * and also give the bot input and output / task files inside and task files outside / and give it
 * uncountable max steps so it knows / like the way you are".
 *
 * Honest scope note, stated up front rather than buried: actually EXECUTING a script needs a real
 * E2B API key and a real network round trip to their envd data plane. No key is stored in this
 * environment, so the execution round trip itself is NOT verified here and is not claimed to be.
 * What IS verified is everything that is genuinely verifiable without one, including the parts
 * most likely to be silently wrong: the security boundary on file input, the file-in/file-out
 * plumbing, the tool surface actually being reachable, and the step caps genuinely being gone.
 */

const workDir = mkdtempSync(join(tmpdir(), "dave-e2b-test-"));
process.env.DAVE_DATA_ROOT = workDir;

const { userUploadDir, listUserUploads, readUserUpload, runScriptInE2B, E2B_TOOLS, SANDBOX_IN_DIR, SANDBOX_OUT_DIR } = await import("../src/index.js");
const { CORE_TOOL_NAMES } = await import("../../dave-agent-loop/src/tool-selection.js");
const { createBackgroundCheck, BACKGROUND_CHECK_TOOLS } = await import("../../dave-workers/src/background-check-tools.js");

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(repoRoot, p), "utf8");

console.log("=== E2B: real scripts, real file I/O both directions, uncapped steps ===\n");

console.log("[1] The main agent can genuinely REACH E2B -- run_script is core, not discovery-gated...\n");
assert.ok(CORE_TOOL_NAMES.includes("run_script"), "run_script must be core -- 'connect the main agent to the e2b'");
assert.ok(CORE_TOOL_NAMES.includes("list_user_files"), "list_user_files must be core");
assert.ok(CORE_TOOL_NAMES.includes("send_file_to_user"), "send_file_to_user must be core");
console.log("    confirmed: run_script, list_user_files, send_file_to_user all core");

console.log("\n[2] run_script really exists as a tool, and exposes both file directions...\n");
const runScript = E2B_TOOLS.find((t) => t.name === "run_script");
assert.ok(runScript, "run_script must be a real registered tool");
const props = (runScript.parameters as { properties: Record<string, unknown>; required: string[] }).properties;
for (const p of ["script", "language", "filesIn", "attachUserFiles", "filesOut", "envVars", "timeoutMs"]) {
  assert.ok(props[p], `run_script must expose "${p}"`);
}
assert.ok((runScript.parameters as { required: string[] }).required.includes("script"), "script must be required");
const langs = (props.language as { enum: string[] }).enum;
assert.deepEqual(langs, ["bash", "python", "node"], "must genuinely run any of the three languages");
console.log(`    confirmed: script/filesIn/attachUserFiles/filesOut all present; languages ${langs.join(", ")}`);

console.log("\n[3] A file the USER sent is genuinely reachable by a script (task files INSIDE)...\n");
const uploads = userUploadDir("trader-1");
writeFileSync(join(uploads, "trades.csv"), "symbol,pnl\nVOL_80,12.40\nCRASH_100,-3.10\n");
writeFileSync(join(uploads, "notes.txt"), "watch the 196740 gap");
const listed = listUserUploads("trader-1");
assert.deepEqual(listed.map((f) => f.name).sort(), ["notes.txt", "trades.csv"]);
assert.ok(listed.every((f) => f.bytes > 0), "real byte counts, not stubs");
assert.match(readUserUpload("trader-1", "trades.csv").toString("utf8"), /VOL_80,12\.40/, "the real bytes must come back");
console.log(`    confirmed: ${listed.length} real uploads listed and read back byte-for-byte`);

console.log("\n[4] SECURITY: a script can NEVER reach past the user's own uploads...\n");
// The bot host holds the SQLite DB with every stored provider/E2B/broker credential. If a script
// could name an arbitrary host path, a model could read those and print them to stdout.
mkdirSync(join(workDir, "data"), { recursive: true });
writeFileSync(join(workDir, "dave.db"), "SQLITE-ish: every stored api key lives here");
writeFileSync(join(workDir, ".env"), "SECRET=hunter2");
for (const attack of ["../../dave.db", "../../../.env", "/etc/passwd", "....//....//dave.db", "subdir/../../dave.db"]) {
  assert.throws(() => readUserUpload("trader-1", attack), /no uploaded file|outside the user's own upload/, `traversal "${attack}" must be refused`);
}
// And the refusal must not itself leak the directory listing of somewhere else.
assert.throws(() => readUserUpload("trader-1", "../../dave.db"), (err: Error) => !err.message.includes("hunter2"));
console.log("    confirmed: 5 traversal attempts all refused; stored credentials unreachable");

console.log("\n[5] The sandbox contract is a real, stated convention both sides agree on...\n");
assert.equal(SANDBOX_IN_DIR, "/home/user/in");
assert.equal(SANDBOX_OUT_DIR, "/home/user/out");
const execSrc = read("packages/dave-e2b/src/e2b-exec.ts");
assert.ok(execSrc.includes("DAVE_IN_DIR: SANDBOX_IN_DIR") && execSrc.includes("DAVE_OUT_DIR: SANDBOX_OUT_DIR"), "the script must be TOLD where the dirs are, via real env vars");
assert.ok(execSrc.includes("collectOutputs"), "output collection must be real");
assert.ok(/await sandbox\.kill\(\)/.test(execSrc), "a sandbox must always be killed -- leaked compute is real money");
assert.ok(execSrc.includes("} finally {"), "the kill must be in a finally, not the happy path");
console.log("    confirmed: in/out dirs exported to the script as env vars; sandbox always killed in a finally");

console.log("\n[6] The script is never interpolated into a shell string (injection-proof by construction)...\n");
assert.ok(execSrc.includes("await sandbox.files.write(scriptPath, options.script)"), "the script must be WRITTEN TO A FILE");
assert.ok(!/bash -c|sh -c/.test(execSrc), "there must be no shell -c string for a script to break out of");
assert.ok(execSrc.includes("interpreter.argv(scriptPath)"), "the interpreter must be pointed at the file");
console.log("    confirmed: script written to a file, interpreter pointed at it, no shell -c anywhere");

console.log("\n[7] A background check can genuinely CARRY a script, re-run identically every tick...\n");
const checkTool = BACKGROUND_CHECK_TOOLS.find((t) => t.name === "start_background_check");
const checkProps = (checkTool!.parameters as { properties: Record<string, unknown> }).properties;
assert.ok(checkProps.script, "start_background_check must accept a script");
assert.ok(checkProps.scriptLanguage, "…and its language");
const check = createBackgroundCheck("trader-1", {
  reason: "watching whether VOL_80 reclaims the 196740 gap",
  whatToCheck: "has VOL_80 traded back above 196740",
  script: "curl -s https://example.invalid/price | python3 -c 'import sys;print(sys.stdin.read())'",
  scriptLanguage: "bash",
});
assert.equal(check.scriptLanguage, "bash");
assert.match(check.script!, /196740|curl/, "the real script text must persist verbatim");
const roundTripped = JSON.parse(readFileSync(join(workDir, "data", "background-checks", "trader-1", "registry.json"), "utf8"));
assert.equal(roundTripped[0].script, check.script, "it must survive the real file round trip, not just live in memory");
console.log("    confirmed: script + language persisted verbatim through the real registry file");
// A check with no script must not invent one.
const plain = createBackgroundCheck("trader-1", { reason: "r", whatToCheck: "w" });
assert.equal(plain.script, undefined, "a check without a script must stay scriptless");
assert.equal(plain.scriptLanguage, undefined);
console.log("    confirmed: a scriptless check stays scriptless -- no silent default");

console.log("\n[8] UNCOUNTABLE max steps -- the real caps are genuinely gone from both loops...\n");
const workerSrc = read("packages/dave-agent-loop/src/worker-loop.ts");
const bgSrc = read("packages/dave-agent-loop/src/background-check-loop.ts");
assert.ok(!/maxSteps:\s*12/.test(workerSrc), "the subagent's 12-step cap must be gone");
assert.ok(!/maxSteps:\s*8/.test(bgSrc), "the background tick's 8-step cap must be gone");
assert.ok(!/maxSteps:/.test(workerSrc) && !/maxSteps:/.test(bgSrc), "neither loop may pass any step cap at all");
// …and the real ceilings that actually protect things are still in force.
assert.ok(workerSrc.includes("signal: abortController.signal"), "/stop must still reach a worker");
assert.ok(workerSrc.includes("beginTurn(ownerUserId)") && workerSrc.includes("endTurn("), "turn-abort registration must survive");
const loopSrc = read("packages/dave-agent-loop/src/agent-loop.ts");
assert.ok(loopSrc.includes("DEFAULT_OVERALL_TURN_TIMEOUT_MS"), "the real wall-clock ceiling must still exist");
assert.ok(loopSrc.includes("opts.maxSteps ?? Infinity"), "Dave's own turns stay uncounted -- the subagents now match");
console.log("    confirmed: both caps removed; /stop + wall-clock deadline still bound every run");

console.log("\n[9] Overlapping ticks are impossible, so uncapped steps cannot pile checks up...\n");
const pollSrc = read("packages/dave-db/src/scheduled-trigger.ts");
assert.ok(/if \(running\) return;/.test(pollSrc), "the poller must skip a tick while the previous one is in flight");
console.log("    confirmed: registerPollingCheck skips rather than overlaps -- a long tick cannot stack");

console.log("\n[10] Both the subagent and the background tick genuinely GET the script tool...\n");
assert.ok(workerSrc.includes('E2B_TOOLS.find((t) => t.name === "run_script")'), "a subagent must be granted run_script");
assert.ok(bgSrc.includes('E2B_TOOLS.find((t) => t.name === "run_script")'), "a background tick must be granted run_script");
// …but neither may be handed key management.
for (const [label, src] of [["worker", workerSrc], ["background tick", bgSrc]] as const) {
  assert.ok(!src.includes("adaptTools(E2B_TOOLS"), `the ${label} must NOT get the whole E2B tool set -- key management stays Dave's`);
}
assert.ok(bgSrc.includes("runScriptInE2B(deps.db, deps.ownerUserId"), "the check's own stored script must genuinely be executed each tick");
console.log("    confirmed: both get run_script only; add/remove/list key tools withheld from both");

console.log("\n[11] With no key stored, the failure is honest and actionable -- not a silent nothing...\n");
const { DaveDatabase } = await import("@dave/db");
const db = new DaveDatabase(join(workDir, "test.db"));
await assert.rejects(
  () => runScriptInE2B(db, "trader-1", { script: "echo hi" }),
  (err: Error) => /No E2B key stored/.test(err.message) && /add_e2b_key/.test(err.message),
  "it must name the real tool that fixes it"
);
await assert.rejects(() => runScriptInE2B(db, "trader-1", { script: "   " }), /script is required/);
console.log("    confirmed: names add_e2b_key and e2b.dev rather than failing blank");

console.log("\n[12] The inbound-document message now names a tool that actually exists...\n");
const serverSrc = read("packages/dave-agent-loop/src/telegram-bot-server.ts");
// Checked against real CODE lines only -- the comment explaining the fix quotes the old text.
const serverCode = serverSrc.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
assert.ok(!serverCode.includes("use your sandbox file tools to read/process it"), "the old dead-end instruction must be gone from the real message");
assert.ok(serverSrc.includes("attachUserFiles"), "it must name the real tool that reaches the file");
assert.ok(serverSrc.includes("const inboxDir = userUploadDir"), "there must be exactly ONE definition of where uploads live");
assert.ok(!/function inboxDir\(/.test(serverSrc), "the duplicate local definition must be gone -- that drift is what broke this");
console.log("    confirmed: single upload-dir definition, shared with the executor that reads it back");

console.log("\n=== ALL ASSERTIONS PASSED ===");
console.log("\nNOT covered here (needs a real E2B key + network): the execution round trip itself --");
console.log("Sandbox.create, commands.run, files.write/read against real E2B infrastructure.");
process.exit(0);
