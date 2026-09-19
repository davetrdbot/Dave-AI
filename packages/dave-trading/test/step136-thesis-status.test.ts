import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workDir = mkdtempSync(join(tmpdir(), "dave-thesis-"));
process.env.DAVE_DATA_ROOT = workDir;

const { setThesisStatus, getThesisStatus, listThesisStatuses, thesisStatusLabel, THESIS_STATUSES, InvalidThesisStatusError } = await import("@dave/trading");

/** Self-Awareness spec part 2: "Is my idea still valid?" -- the 4 states, and alert-on-change. */

const USER = "user-thesis-1";

console.log("=== 'Is my idea still valid?' thesis-status tracking ===\n");

try {
  console.log("[1] The four states exist; an invalid one is refused...\n");
  assert.deepEqual(THESIS_STATUSES, ["still_valid", "weakening", "invalidated", "recovering"]);
  assert.throws(() => setThesisStatus(USER, { ticket: "T1", symbol: "VOL_80", status: "maybe" as never }), InvalidThesisStatusError);
  console.log("    confirmed: still_valid / weakening / invalidated / recovering; junk refused");

  console.log("\n[2] First set is a change (new); same status again is NOT a change (no spam)...\n");
  let r = setThesisStatus(USER, { ticket: "T1", symbol: "VOL_80", status: "still_valid" });
  assert.equal(r.changed, true, "the first status is a change");
  assert.equal(r.previous, undefined);
  r = setThesisStatus(USER, { ticket: "T1", symbol: "VOL_80", status: "still_valid" });
  assert.equal(r.changed, false, "re-affirming the same status is not a change -- no repeat alert");
  assert.equal(getThesisStatus(USER, "T1")?.history.length, 1, "history didn't grow on the no-op");
  console.log("    confirmed: change on first set, no-op on re-affirm");

  console.log("\n[3] A real transition is flagged as changed, with the previous state and the note...\n");
  r = setThesisStatus(USER, { ticket: "T1", symbol: "VOL_80", status: "weakening", note: "M15 momentum stalling, no follow-through past the FVG" });
  assert.equal(r.changed, true);
  assert.equal(r.previous, "still_valid", "it reports what it changed FROM");
  assert.equal(r.record.note, "M15 momentum stalling, no follow-through past the FVG");
  console.log(`    confirmed: still_valid -> weakening, note captured (${thesisStatusLabel("weakening")})`);

  console.log("\n[4] Invalidated then recovering -- the whole thesis journey is recorded...\n");
  setThesisStatus(USER, { ticket: "T1", symbol: "VOL_80", status: "invalidated", note: "structure broke against me" });
  setThesisStatus(USER, { ticket: "T1", symbol: "VOL_80", status: "recovering", note: "reclaimed the level, momentum back" });
  const hist = getThesisStatus(USER, "T1")?.history.map((h) => h.status);
  assert.deepEqual(hist, ["still_valid", "weakening", "invalidated", "recovering"], `full journey recorded, got ${hist?.join(" -> ")}`);
  console.log(`    confirmed: ${hist?.join(" -> ")}`);

  console.log("\n[5] Multiple open trades are tracked independently...\n");
  setThesisStatus(USER, { ticket: "T2", symbol: "CRASH_200", status: "still_valid" });
  assert.equal(listThesisStatuses(USER).length, 2);
  assert.equal(getThesisStatus(USER, "T2")?.status, "still_valid");
  assert.equal(getThesisStatus(USER, "T1")?.status, "recovering", "T1's state is untouched by T2");
  console.log("    confirmed: per-ticket, independent");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
