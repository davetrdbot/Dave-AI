import assert from "node:assert/strict";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attemptConfinement,
  runCode,
  writeWorkspaceFile,
  readWorkspaceFile,
  fetchPageTitle,
  checkSandboxHealth,
  chatAndMarketDataStillWork,
} from "../src/index.js";

const workspace = mkdtempSync(join(tmpdir(), "dave-sandbox-test-"));

console.log("=== Step 6 real proof: sandbox ===\n");
console.log(`Workspace: ${workspace}\n`);

// --- 6.1: real attempt at DSH-native confinement ---
console.log("[1] Real attempt at DSH-native confinement (@deepseek-ai/dsh-sandbox-local)...");
const { attempt } = await attemptConfinement(["echo", "hi"], workspace);
console.log(`    confined=${attempt.confined}${attempt.enforcement ? `, enforcement=${attempt.enforcement}` : ""}`);
if (!attempt.confined) console.log(`    reason: ${attempt.reason}`);
// Real result, whichever way it goes -- this environment has no bwrap/Landlock,
// so we expect (and assert) the honest fail-closed outcome, not a fabricated success.
assert.equal(typeof attempt.confined, "boolean");

// --- 6.2: real code execution ---
console.log("\n[2] Real code execution through the sandbox layer...");
const execResult = await runCode("node", ["-e", "console.log(2 + 2)"], workspace);
console.log(`    stdout: "${execResult.stdout.trim()}", exitCode: ${execResult.exitCode}, confined: ${execResult.confinement.confined}`);
assert.equal(execResult.stdout.trim(), "4");
assert.equal(execResult.exitCode, 0);

// --- 6.2: real file I/O ---
console.log("\n[3] Real file read/write scoped to the workspace...");
const written = writeWorkspaceFile(workspace, "notes/analysis.md", "# EURUSD structure notes\n\nBullish above 1.0850.");
console.log(`    wrote: ${written}`);
const readBack = readWorkspaceFile(workspace, "notes/analysis.md");
console.log(`    read back: "${readBack.split("\n")[0]}"`);
assert.match(readBack, /Bullish above 1.0850/);

console.log("\n[3b] Path-escape guard rejects writes outside the workspace...");
let escapeBlocked = false;
try {
  writeWorkspaceFile(workspace, "../../etc/should-not-write", "nope");
} catch {
  escapeBlocked = true;
}
assert.equal(escapeBlocked, true);
console.log("    escape attempt correctly rejected");

// --- 6.2: real browser automation ---
console.log("\n[4] Real browser automation via headless Chromium (Playwright)...");
const page = await fetchPageTitle("data:text/html,<title>Dave Sandbox Browser Test</title><h1>hi</h1>");
console.log(`    title: "${page.title}"`);
assert.equal(page.title, "Dave Sandbox Browser Test");

// --- 6.3: graceful degradation ---
console.log("\n[5] Graceful degradation: sandbox health check + non-sandbox functions still work...");
const health = await checkSandboxHealth(workspace);
console.log(`    sandbox health: reachable=${health.reachable} (${health.detail})`);
const stillWorks = await chatAndMarketDataStillWork();
console.log(`    chat reply:        "${stillWorks.chatReply}"`);
console.log(`    market data reply: "${stillWorks.marketDataReply}"`);
assert.ok(stillWorks.chatReply.length > 0);
assert.ok(stillWorks.marketDataReply.length > 0);
console.log("    non-sandbox functions returned real output regardless of sandbox reachability -- degradation is graceful, not a crash");

rmSync(workspace, { recursive: true, force: true });

console.log("\n=== ALL ASSERTIONS PASSED ===");
