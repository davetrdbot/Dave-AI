import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Ported from Nous Research's Hermes Agent (NousResearch/hermes-agent,
 * tools/memory_tool_store.py), read from the real source rather than the docs.
 *
 * The gap it closes: every memory write path here was APPEND-ONLY. Once the budget was reached
 * the model had no move left -- it could not free room and add in the same breath, so a fact was
 * simply lost. Hermes' answer is an atomic batch whose budget is checked only on the FINAL state,
 * so one call can remove stale entries AND add the new one even when the add alone would overflow.
 *
 * Two supporting pieces come with it and both matter:
 *   - a rejection carries the entries actually stored, so the model can fix it in the same turn
 *     (neither implementation has a read action -- memory is already in the prompt);
 *   - a consecutive-failure cap, so a fragile consolidation can never eat the turn.
 */

const workDir = mkdtempSync(join(tmpdir(), "dave-step152-"));
process.env.DAVE_DATA_ROOT = workDir;

const {
  applyMemoryOperations,
  readMemoryEntries,
  resetConsolidationFailures,
  appendUserFact,
  loadFrozenSnapshot,
  FROZEN_PAIR_CHAR_BUDGET,
  MAX_CONSOLIDATION_FAILURES,
  MemoryBatchTooLargeError,
  MemoryEntryNotFoundError,
  MemoryConsolidationStuckError,
} = await import("../src/hermes-store.js");
const { MEMORY_WRITE_TOOLS } = await import("../src/write-tools.js");

const U = "trader-1";
const fresh = (id: string) => { resetConsolidationFailures(id); return id; };

console.log("=== Batch memory editing (ported from Hermes Agent) ===\n");

console.log("[1] Add / replace / remove all apply in ONE atomic call...\n");
{
  const u = fresh("t-basic");
  const r = applyMemoryOperations(u, [
    { action: "add", target: "user", content: "trades synthetic pairs only" },
    { action: "add", target: "memory", content: "EA reconnects on its own after a deploy" },
  ]);
  assert.equal(r.applied, 2);
  assert.deepEqual(readMemoryEntries(u, "user"), ["trades synthetic pairs only"]);
  applyMemoryOperations(u, [{ action: "replace", target: "user", oldText: "synthetic", content: "trades Deriv synthetics, never FX" }]);
  assert.deepEqual(readMemoryEntries(u, "user"), ["trades Deriv synthetics, never FX"]);
  applyMemoryOperations(u, [{ action: "remove", target: "memory", oldText: "reconnects" }]);
  assert.deepEqual(readMemoryEntries(u, "memory"), []);
  console.log("    confirmed: add, replace (whole entry), remove");
}

console.log("\n[2] THE POINT: a batch that frees room AND adds succeeds where the add alone cannot...\n");
{
  const u = fresh("t-overflow");
  // Fill memory to just under the ceiling with disposable entries.
  const filler = "x".repeat(400);
  for (let i = 0; i < 12; i++) applyMemoryOperations(u, [{ action: "add", target: "memory", content: `${filler} #${i}` }]);
  const before = readMemoryEntries(u, "memory").length;
  const newFact = "y".repeat(500);

  // The add on its own overflows -- exactly the dead end append-only writes used to hit.
  assert.throws(
    () => applyMemoryOperations(u, [{ action: "add", target: "memory", content: newFact }]),
    MemoryBatchTooLargeError,
    "a lone add at capacity must still be refused"
  );

  // The SAME add, batched with removals, goes through -- the budget is checked on the end state.
  resetConsolidationFailures(u);
  const r = applyMemoryOperations(u, [
    { action: "remove", target: "memory", content: undefined as never, oldText: "#0" },
    { action: "remove", target: "memory", oldText: "#1" },
    { action: "add", target: "memory", content: newFact },
  ]);
  const after = readMemoryEntries(u, "memory");
  assert.ok(after.includes(newFact), "the new fact must genuinely be saved");
  assert.equal(after.length, before - 1, "two removed, one added");
  assert.ok(r.chars <= FROZEN_PAIR_CHAR_BUDGET);
  console.log(`    confirmed: lone add refused, same add inside a batch saved (${r.chars}/${r.budget} chars, ${r.usagePercent}%)`);
}

console.log("\n[3] A rejection hands back the real entries, so it can be fixed in-turn...\n");
{
  const u = fresh("t-entries");
  const filler = "z".repeat(500);
  for (let i = 0; i < 10; i++) applyMemoryOperations(u, [{ action: "add", target: "memory", content: `${filler} #${i}` }]);
  try {
    applyMemoryOperations(u, [{ action: "add", target: "memory", content: "w".repeat(600) }]);
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof MemoryBatchTooLargeError);
    assert.ok(err.currentEntries.memory.length > 0, "the entries actually stored must come back with the error");
    assert.match(err.message, /ONE batch/, "…and it must say how to fix it");
    assert.match(err.message, /knowledge_draft/, "…and where a durable lesson belongs instead");
  }
  console.log("    confirmed: error carries currentEntries + the fix + the knowledge escape hatch");
}

console.log("\n[4] Nothing is written unless the WHOLE batch succeeds...\n");
{
  const u = fresh("t-atomic");
  applyMemoryOperations(u, [{ action: "add", target: "user", content: "keeps a tight risk budget" }]);
  assert.throws(
    () =>
      applyMemoryOperations(u, [
        { action: "add", target: "user", content: "this must NOT survive" },
        { action: "remove", target: "user", oldText: "no such entry anywhere" },
      ]),
    MemoryEntryNotFoundError
  );
  assert.deepEqual(readMemoryEntries(u, "user"), ["keeps a tight risk budget"], "a failed batch must leave the store untouched");
  console.log("    confirmed: all-or-nothing -- a later failure discards earlier operations");
}

console.log("\n[5] A miss also returns the entries, and says what to do...\n");
{
  const u = fresh("t-miss");
  applyMemoryOperations(u, [{ action: "add", target: "memory", content: "spread widens at the London open" }]);
  try {
    applyMemoryOperations(u, [{ action: "replace", target: "memory", oldText: "Tokyo", content: "x" }]);
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof MemoryEntryNotFoundError);
    assert.deepEqual(err.currentEntries.memory, ["spread widens at the London open"]);
    assert.match(err.message, /switch this operation to an add/);
  }
  console.log("    confirmed: a miss is recoverable without a read tool");
}

console.log("\n[6] Whole-entry match wins over a substring match...\n");
{
  const u = fresh("t-match");
  applyMemoryOperations(u, [
    { action: "add", target: "memory", content: "VOL_80" },
    { action: "add", target: "memory", content: "VOL_80 is the one my record burned on" },
  ]);
  applyMemoryOperations(u, [{ action: "replace", target: "memory", oldText: "VOL_80", content: "VOL_80 (exact)" }]);
  const entries = readMemoryEntries(u, "memory");
  assert.equal(entries[0], "VOL_80 (exact)", "the entry that EXACTLY equals oldText must win");
  assert.equal(entries[1], "VOL_80 is the one my record burned on", "the longer entry must be untouched");
  console.log("    confirmed: exact match beats substring, so a short oldText can't hit the wrong entry");
}

console.log("\n[7] A duplicate add is a harmless no-op, not a batch-killing error...\n");
{
  const u = fresh("t-dup");
  applyMemoryOperations(u, [{ action: "add", target: "user", content: "prefers short answers" }]);
  const r = applyMemoryOperations(u, [
    { action: "add", target: "user", content: "prefers short answers" },
    { action: "add", target: "user", content: "based in Lagos" },
  ]);
  assert.deepEqual(readMemoryEntries(u, "user"), ["prefers short answers", "based in Lagos"], "the duplicate is skipped, the real add survives");
  assert.equal(r.applied, 2);
  console.log("    confirmed: re-saving a known fact doesn't lose the operations around it");
}

console.log("\n[8] A stuck consolidation stops after N tries instead of eating the turn...\n");
{
  const u = fresh("t-stuck");
  const filler = "q".repeat(500);
  for (let i = 0; i < 10; i++) applyMemoryOperations(u, [{ action: "add", target: "memory", content: `${filler} #${i}` }]);
  const tooBig = () => applyMemoryOperations(u, [{ action: "add", target: "memory", content: "r".repeat(900) }]);
  for (let i = 0; i < MAX_CONSOLIDATION_FAILURES; i++) assert.throws(tooBig, MemoryBatchTooLargeError);
  assert.throws(tooBig, MemoryConsolidationStuckError, `after ${MAX_CONSOLIDATION_FAILURES} failures it must tell the model to stop`);
  try { tooBig(); } catch (err) {
    assert.match((err as Error).message, /Stop retrying/);
    assert.match((err as Error).message, /get on with answering/, "a failed memory write must never block the reply");
  }
  // A new turn clears it.
  resetConsolidationFailures(u);
  assert.throws(tooBig, MemoryBatchTooLargeError, "the cap counts failures within a turn, not forever");
  console.log(`    confirmed: ${MAX_CONSOLIDATION_FAILURES} strikes -> stop, and a new turn re-arms it`);
}

console.log("\n[9] A successful write clears the counter...\n");
{
  const u = fresh("t-reset");
  const filler = "p".repeat(500);
  for (let i = 0; i < 10; i++) applyMemoryOperations(u, [{ action: "add", target: "memory", content: `${filler} #${i}` }]);
  assert.throws(() => applyMemoryOperations(u, [{ action: "add", target: "memory", content: "s".repeat(900) }]), MemoryBatchTooLargeError);
  applyMemoryOperations(u, [{ action: "remove", target: "memory", oldText: "#0" }]); // succeeds
  // Having succeeded, the model gets its full allowance of attempts again.
  for (let i = 0; i < MAX_CONSOLIDATION_FAILURES; i++) {
    assert.throws(() => applyMemoryOperations(u, [{ action: "add", target: "memory", content: "s".repeat(2000) }]), MemoryBatchTooLargeError);
  }
  console.log("    confirmed: progress resets the strike count");
}

console.log("\n[10] The append-only tools still work, and share the same budget...\n");
{
  const u = fresh("t-compat");
  appendUserFact(u, "runs a $105 account");
  assert.ok(readMemoryEntries(u, "user").includes("runs a $105 account"), "the old writer's output must be readable as an entry");
  applyMemoryOperations(u, [{ action: "replace", target: "user", oldText: "$105", content: "runs a small account, currently ~$105" }]);
  assert.deepEqual(readMemoryEntries(u, "user"), ["runs a small account, currently ~$105"], "…and editable by the new one");
  console.log("    confirmed: the two write paths are the same store, not parallel ones");
}

console.log("\n[11] The tools are real, and say there is no read action...\n");
{
  const edit = MEMORY_WRITE_TOOLS.find((t) => t.name === "edit_memory")!;
  assert.ok(edit, "edit_memory must exist");
  assert.match(edit.description, /FINAL result/, "the batch's whole point must be stated");
  assert.match(edit.description, /no read action and you do not need one/, "…and why there is no read");
  assert.match(edit.description, /Order matters/);
  const ops = (edit.parameters as { properties: { operations: { items: { properties: Record<string, unknown> } } } }).properties.operations.items.properties;
  for (const f of ["action", "target", "content", "oldText"]) assert.ok(ops[f], `operations[].${f} must be exposed`);
  assert.ok(MEMORY_WRITE_TOOLS.find((t) => t.name === "inspect_memory"), "a verbatim inspector for exact substrings");
  console.log("    confirmed: edit_memory + inspect_memory both real and documented");
}

console.log("\n[12] edit_memory is CORE -- a tool it must discover is one it reaches too late...\n");
{
  const { CORE_TOOL_NAMES } = await import("../../dave-agent-loop/src/tool-selection.js");
  assert.ok(CORE_TOOL_NAMES.includes("edit_memory"), "at capacity this is the ONLY tool that can still save a fact");
  console.log("    confirmed: reachable every turn, not discovery-gated");
}

console.log("\n[13] The injected memory block now carries a usage meter...\n");
{
  const u = fresh("t-meter");
  appendUserFact(u, "a fact");
  const snap = loadFrozenSnapshot(u);
  assert.ok(snap.user.includes("a fact"));
  const src = readFileSync(join(import.meta.dirname, "..", "..", "dave-agent-loop", "src", "live-context.ts"), "utf8");
  assert.match(src, /Memory usage: \$\{pct\}%/, "the model must see how full memory is, not just its contents");
  assert.match(src, /pct >= 80/, "…with a nudge to consolidate before it's forced to");
  assert.match(src, /edit_memory/, "…naming the tool that does it");
  console.log("    confirmed: usage % injected, with an 80% consolidation nudge");
}

console.log("\n=== ALL ASSERTIONS PASSED ===");
process.exit(0);
