import type { DaveDatabase } from "@dave/db";
import { proposePatch, getPatch, previewPatch, testPatch, applyPatchToFile } from "./patch-proposal.js";
import { requestApproval, decideApproval, getApproval, getAutoApproveEnabled, setAutoApproveEnabled } from "./approval-gate.js";
import { proposeNewTool, requestToolCreationApproval } from "./tool-creation.js";
import { getVersionHistory, rollbackToVersion } from "./versioning.js";

/**
 * Update 18 (bulk tool-coverage expansion): Step 17/18's real
 * self-improvement machinery (propose -> test -> approve -> apply,
 * hard-gated at every step) had no agent-tool surface at all.
 */
export interface SelfImproveToolContext {
  userId: string;
  db: DaveDatabase;
}

export interface SelfImproveToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: SelfImproveToolContext) => Promise<unknown>;
}

export const SELF_IMPROVE_TOOLS: SelfImproveToolDefinition[] = [
  {
    name: "propose_patch",
    description: "Propose a real, verified-consistent patch to one of your own files. Never applies anything -- must be tested then approved first.",
    parameters: {
      type: "object",
      properties: { targetFile: { type: "string" }, oldContent: { type: "string" }, newContent: { type: "string" }, description: { type: "string" }, reason: { type: "string" } },
      required: ["targetFile", "oldContent", "newContent", "description", "reason"],
    },
    execute: async (args, ctx) => proposePatch(ctx.db, ctx.userId, args as any),
  },
  {
    name: "preview_patch",
    description: "Get a real human-readable +/- preview of a proposed patch by id.",
    parameters: { type: "object", properties: { patchId: { type: "string" } }, required: ["patchId"] },
    execute: async (args, ctx) => {
      const patch = getPatch(ctx.db, ctx.userId, args.patchId as string);
      if (!patch) throw new Error(`no patch "${args.patchId}"`);
      return { preview: previewPatch(patch) };
    },
  },
  {
    name: "test_patch",
    description: "Run a real sandbox test against a proposed patch's candidate content -- status only becomes 'tested' on a genuine exit code 0.",
    parameters: {
      type: "object",
      properties: { patchId: { type: "string" }, workspaceRoot: { type: "string" }, command: { type: "string" }, commandArgs: { type: "array", items: { type: "string" } } },
      required: ["patchId", "workspaceRoot", "command"],
    },
    execute: async (args, ctx) => testPatch(ctx.db, ctx.userId, args.patchId as string, args.workspaceRoot as string, { command: args.command as string, args: (args.commandArgs as string[]) ?? [] }),
  },
  {
    name: "request_approval",
    description: "Request explicit user approval for a real risky change (patch, tool creation, strategy change).",
    parameters: { type: "object", properties: { kind: { type: "string" }, description: { type: "string" }, reason: { type: "string" } }, required: ["kind", "description", "reason"] },
    execute: async (args, ctx) => requestApproval(ctx.db, ctx.userId, args.kind as any, args.description as string, args.reason as string),
  },
  {
    name: "decide_approval",
    description: "Record the user's real approve/decline decision for a pending approval request.",
    parameters: { type: "object", properties: { approvalId: { type: "string" }, approved: { type: "boolean" } }, required: ["approvalId", "approved"] },
    execute: async (args, ctx) => decideApproval(ctx.db, ctx.userId, args.approvalId as string, Boolean(args.approved)),
  },
  {
    name: "get_approval",
    description: "Get a real approval request's current status.",
    parameters: { type: "object", properties: { approvalId: { type: "string" } }, required: ["approvalId"] },
    execute: async (args, ctx) => getApproval(ctx.db, ctx.userId, args.approvalId as string),
  },
  {
    name: "get_auto_approve",
    description: "Check whether auto-approval is enabled for your own self-improvement proposals.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => ({ enabled: getAutoApproveEnabled(ctx.db, ctx.userId) }),
  },
  {
    name: "set_auto_approve",
    description: "Turn auto-approval on/off for your own self-improvement proposals.",
    parameters: { type: "object", properties: { enabled: { type: "boolean" } }, required: ["enabled"] },
    execute: async (args, ctx) => {
      setAutoApproveEnabled(ctx.db, ctx.userId, Boolean(args.enabled));
      return { ok: true };
    },
  },
  {
    name: "apply_patch",
    description: "Apply a real, tested, approved patch to the real file (hard-gated: refuses unless both are genuinely true). writeFile is handled by the caller's runtime, not this tool directly -- returns the real applied version record.",
    parameters: { type: "object", properties: { patchId: { type: "string" }, approvalId: { type: "string" }, currentTipVersionId: { type: "string" } }, required: ["patchId", "approvalId"] },
    execute: async (args, ctx) => {
      const patch = getPatch(ctx.db, ctx.userId, args.patchId as string);
      if (!patch) throw new Error(`no patch "${args.patchId}"`);
      let written = "";
      const record = await applyPatchToFile(ctx.db, ctx.userId, args.patchId as string, args.approvalId as string, (content) => { written = content; }, (args.currentTipVersionId as string) ?? null);
      return { version: record, wroteBytes: written.length };
    },
  },
  {
    name: "propose_new_tool",
    description: "Propose creating a brand-new tool -- goes through the SAME patch propose/test/approve gate as any other self-patch.",
    parameters: {
      type: "object",
      properties: { toolFile: { type: "string" }, existingContent: { type: "string" }, newContent: { type: "string" }, toolName: { type: "string" }, reason: { type: "string" } },
      required: ["toolFile", "existingContent", "newContent", "toolName", "reason"],
    },
    execute: async (args, ctx) => proposeNewTool(ctx.db, ctx.userId, args as any),
  },
  {
    name: "request_tool_creation_approval",
    description: "Request explicit user approval specifically for creating a new tool.",
    parameters: { type: "object", properties: { toolName: { type: "string" }, reason: { type: "string" } }, required: ["toolName", "reason"] },
    execute: async (args, ctx) => requestToolCreationApproval(ctx.db, ctx.userId, args.toolName as string, args.reason as string),
  },
  {
    name: "get_version_history",
    description: "Get the real version history for one of your own files.",
    parameters: { type: "object", properties: { targetFile: { type: "string" } }, required: ["targetFile"] },
    execute: async (args, ctx) => getVersionHistory(ctx.db, ctx.userId, args.targetFile as string),
  },
  {
    name: "rollback_to_version",
    description: "Roll back one of your own files to a real prior version.",
    parameters: { type: "object", properties: { versionId: { type: "string" }, currentTipVersionId: { type: "string" } }, required: ["versionId", "currentTipVersionId"] },
    execute: async (args, ctx) => {
      let written = "";
      const record = rollbackToVersion(ctx.db, ctx.userId, args.versionId as string, args.currentTipVersionId as string, (content) => { written = content; });
      return { version: record, wroteBytes: written.length };
    },
  },
];
