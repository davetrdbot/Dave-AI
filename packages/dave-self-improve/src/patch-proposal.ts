import { extname } from "node:path";
import { createTwoFilesPatch, applyPatch, diffLines } from "diff";
import type { DaveDatabase } from "@dave/db";
import { runCode, writeWorkspaceFile } from "@dave/sandbox";
import { getApproval } from "./approval-gate.js";
import { createVersion, type VersionRecord } from "./versioning.js";

/**
 * Step 17.1/17.2: Dave views its own code and proposes patches -- a
 * real unified diff (via the `diff` package, confirmed zero-dependency
 * and TypeScript-native), verified self-consistent (applying the
 * generated diff to the old content must reproduce the new content
 * exactly, or the patch is refused outright rather than stored broken).
 *
 * The HARD GATE is `applyPatchToFile` below: it is structurally
 * impossible to reach a real file write without both (a) a patch whose
 * `status` is "tested" (a sandbox run that genuinely exited 0 -- never
 * "tested" just because someone asked), and (b) an approval request
 * whose `status` is "approved". Anything else throws before touching a
 * real file.
 */

export type PatchStatus = "proposed" | "tested" | "test_failed" | "applied" | "rolled_back";

export interface PatchProposal {
  id: string;
  targetFile: string;
  oldContent: string;
  newContent: string;
  unifiedDiff: string;
  description: string;
  reason: string;
  status: PatchStatus;
  testStdout?: string;
  testStderr?: string;
}

interface PatchRow {
  id: string;
  target_file: string;
  old_content: string;
  new_content: string;
  unified_diff: string;
  description: string;
  reason: string;
  status: PatchStatus;
  test_stdout: string | null;
  test_stderr: string | null;
}

const TABLE = "patch_proposals";

function ensureTable(db: DaveDatabase): void {
  db.createTable(TABLE, [
    { name: "target_file", type: "TEXT" },
    { name: "old_content", type: "TEXT" },
    { name: "new_content", type: "TEXT" },
    { name: "unified_diff", type: "TEXT" },
    { name: "description", type: "TEXT" },
    { name: "reason", type: "TEXT" },
    { name: "status", type: "TEXT" },
    { name: "test_stdout", type: "TEXT" },
    { name: "test_stderr", type: "TEXT" },
  ]);
}

function toProposal(row: PatchRow): PatchProposal {
  return {
    id: row.id,
    targetFile: row.target_file,
    oldContent: row.old_content,
    newContent: row.new_content,
    unifiedDiff: row.unified_diff,
    description: row.description,
    reason: row.reason,
    status: row.status,
    testStdout: row.test_stdout ?? undefined,
    testStderr: row.test_stderr ?? undefined,
  };
}

export class InconsistentPatchError extends Error {
  constructor(targetFile: string) {
    super(`generated patch for "${targetFile}" does not reproduce the proposed new content -- refusing to store an inconsistent patch`);
    this.name = "InconsistentPatchError";
  }
}

export function proposePatch(
  db: DaveDatabase,
  ownerUserId: string,
  params: { targetFile: string; oldContent: string; newContent: string; description: string; reason: string }
): PatchProposal {
  ensureTable(db);
  const unifiedDiff = createTwoFilesPatch(params.targetFile, params.targetFile, params.oldContent, params.newContent);

  // Real integrity check, not decorative: the diff library's own applyPatch
  // must reproduce newContent from oldContent, or this patch is inconsistent.
  const reproduced = applyPatch(params.oldContent, unifiedDiff);
  if (reproduced !== params.newContent) {
    throw new InconsistentPatchError(params.targetFile);
  }

  const id = db.insert(TABLE, ownerUserId, {
    target_file: params.targetFile,
    old_content: params.oldContent,
    new_content: params.newContent,
    unified_diff: unifiedDiff,
    description: params.description,
    reason: params.reason,
    status: "proposed" satisfies PatchStatus,
    test_stdout: null,
    test_stderr: null,
  });
  return getPatch(db, ownerUserId, id)!;
}

export function getPatch(db: DaveDatabase, ownerUserId: string, patchId: string): PatchProposal | undefined {
  ensureTable(db);
  const row = db.getById(TABLE, ownerUserId, patchId) as unknown as PatchRow | undefined;
  return row ? toProposal(row) : undefined;
}

/** Human-readable +/- preview -- what Dave would actually show before asking for approval. */
export function previewPatch(patch: PatchProposal): string {
  const parts = diffLines(patch.oldContent, patch.newContent);
  return parts.map((p) => (p.added ? p.value.split("\n").filter(Boolean).map((l) => `+ ${l}`).join("\n") : p.removed ? p.value.split("\n").filter(Boolean).map((l) => `- ${l}`).join("\n") : "")).filter(Boolean).join("\n");
}

/**
 * Step 17.2: real sandbox execution, never a claim of testing. Writes
 * ONLY the candidate content into the sandbox workspace -- the real
 * file is never touched here -- then runs the caller's real test
 * command against it (e.g. `node --check candidate.js`, or a real test
 * script). Status becomes "tested" only on a genuine exit code 0.
 */
export async function testPatch(
  db: DaveDatabase,
  ownerUserId: string,
  patchId: string,
  workspaceRoot: string,
  testCommand: { command: string; args: string[] }
): Promise<PatchProposal> {
  const patch = getPatch(db, ownerUserId, patchId);
  if (!patch) throw new Error(`no patch proposal "${patchId}"`);

  const candidateFile = `candidate${extname(patch.targetFile) || ".txt"}`;
  const candidatePath = writeWorkspaceFile(workspaceRoot, candidateFile, patch.newContent);
  const result = await runCode(testCommand.command, [...testCommand.args, candidatePath], workspaceRoot);
  const passed = result.exitCode === 0;

  db.update(TABLE, ownerUserId, patchId, {
    status: (passed ? "tested" : "test_failed") satisfies PatchStatus,
    test_stdout: result.stdout,
    test_stderr: result.stderr,
  });
  return getPatch(db, ownerUserId, patchId)!;
}

export class PatchNotTestedError extends Error {
  constructor(patchId: string) {
    super(`patch "${patchId}" has not passed a sandbox test -- cannot apply (Step 17.2 hard gate: test first, then apply, never the reverse)`);
    this.name = "PatchNotTestedError";
  }
}

export class PatchNotApprovedError extends Error {
  constructor(patchId: string) {
    super(`patch "${patchId}" has no approved approval request -- cannot apply (Step 17.4 hard gate: every risky change needs explicit Yes)`);
    this.name = "PatchNotApprovedError";
  }
}

/**
 * Real bug fixed (bug-hunting pass): `approvalId` was only checked for
 * `status === "approved"` -- it was never checked to actually BE the
 * approval for THIS patch. Any already-approved approval request for a
 * completely unrelated change (an old tool-creation approval, a decoy
 * "rename a variable" patch the user genuinely said yes to) could be
 * replayed here to unlock applying a different, unrelated tested patch
 * -- e.g. a real change to risk limits or the circuit breaker -- that the
 * user never actually saw or approved. `ApprovalRequest` has no
 * `patchId` field (it's a generic gate shared by patches, tool creation
 * and strategy changes), so the correlation this codebase already relies
 * on elsewhere (both call sites -- proposeNewTool/requestToolCreationApproval
 * and the plain patch flow -- always request approval with the exact same
 * `description`/`reason` as the patch itself; step17's own test does the
 * same) is now enforced here too, not just followed by convention.
 */
export async function applyPatchToFile(
  db: DaveDatabase,
  ownerUserId: string,
  patchId: string,
  approvalId: string,
  writeFile: (content: string) => void,
  currentTipVersionId: string | null
): Promise<VersionRecord> {
  const patch = getPatch(db, ownerUserId, patchId);
  if (!patch) throw new Error(`no patch proposal "${patchId}"`);
  if (patch.status !== "tested") throw new PatchNotTestedError(patchId);

  const approval = getApproval(db, ownerUserId, approvalId);
  if (!approval || approval.status !== "approved" || approval.description !== patch.description || approval.reason !== patch.reason) {
    throw new PatchNotApprovedError(patchId);
  }

  writeFile(patch.newContent);
  db.update(TABLE, ownerUserId, patchId, { status: "applied" satisfies PatchStatus });

  return createVersion(db, ownerUserId, {
    targetFile: patch.targetFile,
    evolvedFrom: currentTipVersionId,
    changelogEntry: `${patch.description} -- ${patch.reason}`,
    snapshotContent: patch.newContent,
  });
}
