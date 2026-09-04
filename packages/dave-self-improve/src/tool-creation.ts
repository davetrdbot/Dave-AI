import type { DaveDatabase } from "@dave/db";
import { proposePatch, testPatch, applyPatchToFile, type PatchProposal } from "./patch-proposal.js";
import { requestApproval, type ApprovalRequest } from "./approval-gate.js";

/**
 * Step 17.6: any dynamic tool-creation capability follows the SAME
 * test-first, approval-required gate as any other self-patch -- this
 * is deliberately NOT a second, parallel gate. A new tool is source
 * code being added to a real file, same as any other patch; this
 * module is a thin, explicitly-named wrapper over `patch-proposal.ts`
 * and `approval-gate.ts` so that fact is provable (they're literally
 * the same functions, same hard gates), not just asserted in a comment.
 */

export function proposeNewTool(
  db: DaveDatabase,
  ownerUserId: string,
  params: { toolFile: string; existingContent: string; newContent: string; toolName: string; reason: string }
): PatchProposal {
  return proposePatch(db, ownerUserId, {
    targetFile: params.toolFile,
    oldContent: params.existingContent,
    newContent: params.newContent,
    description: `create new tool "${params.toolName}"`,
    reason: params.reason,
  });
}

export const testNewTool = testPatch;
export const applyNewTool = applyPatchToFile;

export function requestToolCreationApproval(db: DaveDatabase, ownerUserId: string, toolName: string, reason: string): ApprovalRequest {
  return requestApproval(db, ownerUserId, "tool-creation", `create new tool "${toolName}"`, reason);
}
