import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readInternalToolDoc,
  topicForTool,
  recallToolDoc,
  callWithDocRecallRequired,
  seedInternalToolDocSkills,
  listSkills,
  deleteSkill,
  PermanentSkillError,
  RecallRequiredError,
} from "../src/index.js";

console.log("=== Update 13 real proof: permanent skill docs teaching Dave its own tools, real recall enforcement ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-update13-"));
const OWNER = "user-1";

try {
  process.chdir(workDir);

  // --- [1] The three real doc files genuinely exist and contain real content ---
  console.log("[1] The three real skill docs genuinely exist on disk with real content...\n");
  const e2bDoc = readInternalToolDoc("e2b-sandbox");
  const eaDoc = readInternalToolDoc("ea-webhook");
  const rfeedDoc = readInternalToolDoc("rfeed-tools");
  assert.ok(e2bDoc.includes("gRPC"), "the E2B doc must genuinely explain the real gRPC-vs-REST limit");
  assert.ok(eaDoc.includes("heartbeat"), "the EA webhook doc must genuinely explain the real heartbeat round trip");
  assert.ok(rfeedDoc.includes("CustomSymbolTradeRefusedError"), "the R_Feed doc must genuinely reference the real safety error type");
  console.log(`    e2b-sandbox-skill.md: ${e2bDoc.length} bytes; ea-webhook-skill.md: ${eaDoc.length} bytes; rfeed-tools-skill.md: ${rfeedDoc.length} bytes`);

  // --- [2] Tool-to-topic mapping is real and specific ---
  console.log("\n[2] Real tool-to-doc-topic mapping...\n");
  assert.equal(topicForTool("create_e2b_sandbox"), "e2b-sandbox");
  assert.equal(topicForTool("trade_execute"), "ea-webhook");
  assert.equal(topicForTool("place_paper_trade"), "rfeed-tools");
  assert.equal(topicForTool("list_skills"), undefined, "a tool with no genuine 'unfamiliar' risk must NOT be gated");
  console.log("    create_e2b_sandbox->e2b-sandbox, trade_execute->ea-webhook, place_paper_trade->rfeed-tools, list_skills->ungated");

  // --- [3] REAL enforcement: calling an unfamiliar tool without recalling its doc genuinely throws ---
  console.log("\n[3] Real enforcement: an unfamiliar tool call WITHOUT reading its doc first genuinely throws...\n");
  let refused = false;
  try {
    callWithDocRecallRequired(OWNER, "create_e2b_sandbox", () => "should not run");
  } catch (err) {
    refused = err instanceof RecallRequiredError;
  }
  assert.ok(refused, "must genuinely refuse to use an unfamiliar tool before its doc has been recalled");
  console.log("    genuinely refused: RecallRequiredError -- the tool's own function never ran");

  // --- [4] After genuinely recalling (reading) the doc, the SAME tool call succeeds ---
  console.log("\n[4] After genuinely recalling the real doc content, the same call succeeds...\n");
  const recalledContent = recallToolDoc(OWNER, "create_e2b_sandbox");
  assert.equal(recalledContent, e2bDoc, "recall must return the SAME real file content, not a summary");
  let ranForReal = false;
  const result = callWithDocRecallRequired(OWNER, "create_e2b_sandbox", () => {
    ranForReal = true;
    return "sandbox created";
  });
  assert.equal(result, "sandbox created");
  assert.ok(ranForReal, "the real tool function must have genuinely executed this time");
  console.log(`    real recall content matched the real file (${recalledContent.length} bytes) -- tool call now genuinely succeeds: "${result}"`);

  // --- [4b] Recall is per (actor, tool) -- a DIFFERENT unfamiliar tool still needs its OWN recall ---
  console.log("\n[4b] Recall is per-tool -- reading the E2B doc does NOT satisfy the EA-webhook doc's own gate...\n");
  let stillRefused = false;
  try {
    callWithDocRecallRequired(OWNER, "trade_execute", () => "should not run");
  } catch (err) {
    stillRefused = err instanceof RecallRequiredError;
  }
  assert.ok(stillRefused, "recalling one doc must NOT silently satisfy a different tool's own doc gate");
  recallToolDoc(OWNER, "trade_execute");
  const tradeResult = callWithDocRecallRequired(OWNER, "trade_execute", () => "trade placed");
  assert.equal(tradeResult, "trade placed");
  console.log("    trade_execute genuinely still gated until its OWN doc (ea-webhook) is recalled -- then succeeds");

  // --- [4c] A tool with no mapped doc is never gated at all ---
  console.log("\n[4c] An ungated tool (no mapped doc) runs immediately, no recall needed...\n");
  const ungatedResult = callWithDocRecallRequired(OWNER, "list_skills", () => "ran immediately");
  assert.equal(ungatedResult, "ran immediately");
  console.log("    real, immediate execution -- no doc gate applies to tools outside the mapped set");

  // --- [5] Permanent skills: the three docs seeded as real, undeletable per-user skills ---
  console.log("\n[5] The three docs seeded as real, PERMANENT per-user skills (list_skills shows them, deletion refused)...\n");
  const seeded = seedInternalToolDocSkills(OWNER);
  assert.equal(seeded.length, 3);
  assert.ok(seeded.every((s) => s.permanent === true));
  const names = listSkills(OWNER).map((s) => s.name);
  assert.ok(names.includes("How to use: e2b-sandbox"));
  assert.ok(names.includes("How to use: ea-webhook"));
  assert.ok(names.includes("How to use: rfeed-tools"));
  console.log(`    real permanent skills seeded: ${seeded.map((s) => s.name).join(", ")}`);

  let permErr = false;
  try {
    deleteSkill(OWNER, seeded[0].id);
  } catch (err) {
    permErr = err instanceof PermanentSkillError;
  }
  assert.ok(permErr, "these must be genuinely undeletable, same enforcement as Update 10's tool-usage skill");
  console.log("    genuinely refused deletion: PermanentSkillError");

  console.log("\n[5b] Re-seeding updates the SAME skill ids in place, never duplicating...\n");
  const reseeded = seedInternalToolDocSkills(OWNER);
  assert.deepEqual(
    reseeded.map((s) => s.id).sort(),
    seeded.map((s) => s.id).sort()
  );
  assert.equal(listSkills(OWNER).filter((s) => s.name.startsWith("How to use:")).length, 3, "must never duplicate on re-seed");
  console.log("    same 3 skill ids after re-seeding -- no duplicates created");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
