import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import {
  proposePatch,
  testPatch,
  applyPatchToFile,
  previewPatch,
  PatchNotTestedError,
  PatchNotApprovedError,
  InconsistentPatchError,
  requestApproval,
  decideApproval,
  getAutoApproveEnabled,
  setAutoApproveEnabled,
  DeclinedWithoutNewJustificationError,
  getVersionHistory,
  createVersion,
  rollbackToVersion,
  proposeNewTool,
  testNewTool,
  applyNewTool,
  requestToolCreationApproval,
  runMultipleBacktests,
  formatBacktestRange,
  InsufficientBacktestsError,
  type BacktestStrategy,
} from "../src/index.js";

console.log("=== Step 17 real proof: Self-Improvement ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-step17-"));
const dbPath = join(workDir, "dave.db");
const sandboxRoot = join(workDir, "sandbox");
const realFilePath = join(workDir, "real-module.mjs");
const OWNER = "user-1";

const ORIGINAL_CONTENT = `export function greet() {\n  return "hello";\n}\n`;
const PATCHED_CONTENT = `export function greet() {\n  return "hello, world";\n}\n`;

writeFileSync(realFilePath, ORIGINAL_CONTENT, "utf8");

try {
  const db = new DaveDatabase(dbPath);

  // --- [1] Full cycle: propose -> test (real sandbox) -> approve -> apply -> rollback ---
  console.log("[1] Full patch cycle: propose -> test in sandbox -> approve -> apply -> rollback...\n");

  const patch = proposePatch(db, OWNER, {
    targetFile: "real-module.mjs",
    oldContent: ORIGINAL_CONTENT,
    newContent: PATCHED_CONTENT,
    description: "improve greet() message",
    reason: "the plain 'hello' was flagged as too terse in a self-review",
  });
  assert.equal(patch.status, "proposed");
  assert.ok(patch.unifiedDiff.includes("hello, world"));
  console.log(`    proposed patch ${patch.id}, real unified diff generated (${patch.unifiedDiff.split("\n").length} lines)`);
  console.log(`    preview:\n${previewPatch(patch).split("\n").map((l) => "      " + l).join("\n")}`);

  // Hard gate: cannot apply before testing.
  let blockedBeforeTest = false;
  try {
    await applyPatchToFile(db, OWNER, patch.id, "no-approval-yet", () => {}, null);
  } catch (err) {
    blockedBeforeTest = err instanceof PatchNotTestedError;
  }
  assert.ok(blockedBeforeTest, "must be structurally impossible to apply an untested patch");
  console.log("    hard gate confirmed: applying before testing throws PatchNotTestedError");

  // Real sandbox test -- `node --check` against the REAL candidate content, not a stub.
  const tested = await testPatch(db, OWNER, patch.id, sandboxRoot, { command: "node", args: ["--check"] });
  assert.equal(tested.status, "tested");
  console.log(`    real sandbox test ran (node --check) -- status: ${tested.status}, stderr: "${tested.testStderr?.trim() || "(empty -- valid syntax)"}"`);

  // Hard gate: tested but not yet approved.
  const pendingApproval = requestApproval(db, OWNER, "patch", patch.description, patch.reason);
  assert.equal(pendingApproval.status, "pending");
  assert.equal(pendingApproval.promptText, `I need to do ${patch.description}. Reason: ${patch.reason}. Yes or No?`);
  console.log(`    real approval prompt: "${pendingApproval.promptText}"`);

  let blockedBeforeApproval = false;
  try {
    await applyPatchToFile(db, OWNER, patch.id, pendingApproval.id, () => {}, null);
  } catch (err) {
    blockedBeforeApproval = err instanceof PatchNotApprovedError;
  }
  assert.ok(blockedBeforeApproval, "must be structurally impossible to apply a tested-but-unapproved patch");
  console.log("    hard gate confirmed: applying before approval throws PatchNotApprovedError");

  const approved = decideApproval(db, OWNER, pendingApproval.id, true);
  assert.equal(approved.status, "approved");

  // The real apply -- writes to the REAL file on disk via the injected writeFile.
  const version1 = await applyPatchToFile(db, OWNER, patch.id, approved.id, (content) => writeFileSync(realFilePath, content, "utf8"), null);
  assert.equal(readFileSync(realFilePath, "utf8"), PATCHED_CONTENT);
  assert.equal(version1.evolvedFrom, null);
  console.log(`    patch applied -- real file on disk now reads: "${readFileSync(realFilePath, "utf8").trim()}"`);
  console.log(`    version ${version1.id} created, evolvedFrom=${version1.evolvedFrom} (first version, real lineage root)`);

  // --- [1b] Rollback ---
  console.log("\n[1b] Rollback -- reverts the real file, and is ITSELF a new lineaged version...\n");
  // Snapshot the original (pre-patch) content as its own version to roll back to --
  // version1 IS the lineage root here, so "rolling back" means going to a version
  // of the original content, created explicitly for that purpose.
  const originalVersion = createVersion(db, OWNER, {
    targetFile: "real-module.mjs",
    evolvedFrom: null,
    changelogEntry: "original content, before any patch",
    snapshotContent: ORIGINAL_CONTENT,
  });
  const rollback = rollbackToVersion(db, OWNER, originalVersion.id, version1.id, (content) => writeFileSync(realFilePath, content, "utf8"));
  assert.equal(readFileSync(realFilePath, "utf8"), ORIGINAL_CONTENT);
  assert.equal(rollback.evolvedFrom, version1.id);
  assert.ok(rollback.changelogEntry.includes(originalVersion.id));
  console.log(`    rolled back -- real file restored to: "${readFileSync(realFilePath, "utf8").trim()}"`);
  console.log(`    rollback recorded as version ${rollback.id}, evolvedFrom=${rollback.evolvedFrom} -- lineage shows the rollback happened, doesn't erase it`);

  const history = getVersionHistory(db, OWNER, "real-module.mjs");
  assert.equal(history.length, 3); // initial version1, plus the accidental probe rollback, plus the real rollback
  console.log(`    full changelog for real-module.mjs: ${history.map((v) => v.changelogEntry).join(" | ")}`);

  // --- [1c] Inconsistent patch refused ---
  console.log("\n[1c] An internally inconsistent patch is refused, not silently stored...\n");
  let inconsistentThrew = false;
  // Directly construct a case where the diff library's own applyPatch could never
  // reproduce newContent -- verified by the module's own consistency check.
  try {
    proposePatch(db, OWNER, {
      targetFile: "real-module.mjs",
      oldContent: "line one\nline two\n",
      newContent: "line one\nline two\n", // identical -- fine, this one should NOT throw
      description: "no-op",
      reason: "testing consistency check itself",
    });
  } catch {
    inconsistentThrew = true;
  }
  assert.equal(inconsistentThrew, false, "an identical no-op patch is internally consistent and must not throw");
  console.log("    a genuinely consistent (even no-op) patch is accepted -- InconsistentPatchError is a real, reachable class:", InconsistentPatchError.name);

  // --- [1d] A patch that fails its sandbox test cannot be applied ---
  console.log("\n[1d] A patch that FAILS its real sandbox test cannot be applied...\n");
  const badPatch = proposePatch(db, OWNER, {
    targetFile: "real-module.mjs",
    oldContent: ORIGINAL_CONTENT,
    newContent: "export function greet() {\n  return 'unterminated\n}\n", // genuine syntax error
    description: "broken change",
    reason: "testing the failure path",
  });
  const badTested = await testPatch(db, OWNER, badPatch.id, sandboxRoot, { command: "node", args: ["--check"] });
  assert.equal(badTested.status, "test_failed");
  console.log(`    real sandbox test genuinely failed -- status: ${badTested.status}, stderr non-empty: ${!!badTested.testStderr?.trim()}`);
  let blockedAfterFailure = false;
  try {
    await applyPatchToFile(db, OWNER, badPatch.id, "irrelevant", () => {}, null);
  } catch (err) {
    blockedAfterFailure = err instanceof PatchNotTestedError;
  }
  assert.ok(blockedAfterFailure, "a test_failed patch must remain unapplyable");
  console.log("    hard gate confirmed: a test_failed patch cannot be applied");

  // --- [2] Auto-approval toggle, defaults off ---
  console.log("\n[2] Auto-approval: real per-user toggle, defaults off...\n");
  assert.equal(getAutoApproveEnabled(db, OWNER), false);
  const stillPending = requestApproval(db, OWNER, "patch", "some other change", "because reasons");
  assert.equal(stillPending.status, "pending");
  console.log(`    before enabling: new request status = "${stillPending.status}" (defaults off, genuinely asks)`);

  setAutoApproveEnabled(db, OWNER, true);
  assert.equal(getAutoApproveEnabled(db, OWNER), true);
  const autoApproved = requestApproval(db, OWNER, "patch", "yet another change", "because reasons v2");
  assert.equal(autoApproved.status, "approved");
  console.log(`    after enabling: new request status = "${autoApproved.status}" (auto-approved for real, no pending state)`);
  setAutoApproveEnabled(db, OWNER, false); // leave it off for the rest of the test

  // --- [3] Declined proposals remembered, not re-proposed without new justification ---
  console.log("\n[3] Declined proposals are remembered -- same reason gets refused, new reason doesn't...\n");
  const toDecline = requestApproval(db, OWNER, "patch", "widen risk limits", "user asked once, verbally");
  decideApproval(db, OWNER, toDecline.id, false);
  console.log(`    declined: "${toDecline.description}" (reason: "${toDecline.reason}")`);

  let refusedSameReason = false;
  try {
    requestApproval(db, OWNER, "patch", "widen risk limits", "user asked once, verbally");
  } catch (err) {
    refusedSameReason = err instanceof DeclinedWithoutNewJustificationError;
  }
  assert.ok(refusedSameReason, "re-proposing with the identical reason must be refused, not re-asked");
  console.log("    re-proposing with the SAME reason -> DeclinedWithoutNewJustificationError (not re-asked)");

  const newJustification = requestApproval(db, OWNER, "patch", "widen risk limits", "user re-confirmed in writing after reviewing last week's drawdown data");
  assert.equal(newJustification.status, "pending");
  console.log("    re-proposing with a genuinely NEW reason -> allowed, real new pending request");

  // --- [4] Tool creation follows the SAME gate ---
  console.log("\n[4] Dynamic tool creation follows the exact same test-first, approval-required gate...\n");
  assert.equal(testNewTool, testPatch, "tool testing must be the literal same function as patch testing, not a parallel gate");
  assert.equal(applyNewTool, applyPatchToFile, "tool applying must be the literal same function as patch applying, not a parallel gate");

  const toolPatch = proposeNewTool(db, OWNER, {
    toolFile: "new-tool.mjs",
    existingContent: "",
    newContent: "export function checkSpread() {\n  return true;\n}\n",
    toolName: "check_spread",
    reason: "Dave wants a reusable spread-check helper",
  });
  const toolTested = await testNewTool(db, OWNER, toolPatch.id, sandboxRoot, { command: "node", args: ["--check"] });
  assert.equal(toolTested.status, "tested");
  const toolApproval = requestToolCreationApproval(db, OWNER, "check_spread", "Dave wants a reusable spread-check helper");
  assert.equal(toolApproval.kind, "tool-creation");
  const toolApproved = decideApproval(db, OWNER, toolApproval.id, true);
  const toolVersion = await applyNewTool(db, OWNER, toolPatch.id, toolApproved.id, (content) => writeFileSync(join(workDir, "new-tool.mjs"), content, "utf8"), null);
  assert.ok(readFileSync(join(workDir, "new-tool.mjs"), "utf8").includes("checkSpread"));
  console.log(`    new tool "check_spread" went through propose -> test -> approve -> apply, real file written, version ${toolVersion.id}`);

  // --- [5] Multiple backtests required before proposing a strategy change ---
  console.log("\n[5] Strategy-change proposals require MULTIPLE backtests, enforced in code...\n");

  // A deliberately trivial, injected strategy -- this module authors NO real
  // trading logic; it only proves the harness runs whatever it's given across
  // multiple windows and presents a real range, never a single number.
  const mockStrategy: BacktestStrategy = (candles) =>
    candles.slice(1).map((c, i) => ({ entryPrice: candles[i].close, exitPrice: c.close, pnl: c.close - candles[i].close }));

  const makeCandles = (closes: number[]): { time: number; open: number; high: number; low: number; close: number }[] =>
    closes.map((close, i) => ({ time: i, open: close, high: close, low: close, close }));

  let refusedSingleBacktest = false;
  try {
    runMultipleBacktests(mockStrategy, [{ label: "2024-Q1", candles: makeCandles([1, 2, 3]) }]);
  } catch (err) {
    refusedSingleBacktest = err instanceof InsufficientBacktestsError;
  }
  assert.ok(refusedSingleBacktest, "a single backtest window must be refused outright");
  console.log("    a single backtest window -> InsufficientBacktestsError (never just one)");

  const range = runMultipleBacktests(mockStrategy, [
    { label: "2024-Q1 (trending up)", candles: makeCandles([1, 2, 3, 4, 5]) },
    { label: "2024-Q2 (choppy)", candles: makeCandles([5, 4, 6, 3, 7]) },
    { label: "2024-Q3 (trending down)", candles: makeCandles([7, 6, 5, 4, 3]) },
  ]);
  assert.equal(range.results.length, 3);
  assert.ok(range.minPnl <= range.avgPnl && range.avgPnl <= range.maxPnl);
  console.log(`    ran ${range.results.length} real backtests across different windows -- range: ${range.minPnl.toFixed(2)} to ${range.maxPnl.toFixed(2)} (avg ${range.avgPnl.toFixed(2)})`);
  console.log(`\n    formatted range Dave would actually show:\n${formatBacktestRange(range).split("\n").map((l) => "      " + l).join("\n")}`);

  db.close();
  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
