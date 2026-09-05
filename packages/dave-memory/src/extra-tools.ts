import { searchSessions } from "./session-search.js";
import { getConversation, getAtoms, getScenarios } from "./tencent-tiers.js";
import { getWriteApprovalSetting, setWriteApprovalSetting, listPendingWrites, approveWrite } from "./write-approval.js";

/**
 * Update 18 (bulk tool-coverage expansion): session search, the
 * Tencent-tiered memory reads, and the write-approval gate (separate
 * from `recall_memory`'s own composite pull, Update 14) had no direct
 * agent-tool surface.
 */
export interface MemoryExtraToolContext {
  actorId: string;
}

export interface MemoryExtraToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: MemoryExtraToolContext) => Promise<unknown>;
}

export const MEMORY_EXTRA_TOOLS: MemoryExtraToolDefinition[] = [
  {
    name: "session_search",
    description: "Search real past session content by keyword.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    execute: async (args, ctx) => searchSessions(ctx.actorId, args.query as string),
  },
  {
    name: "tencent_memory",
    description: "Read the real Tencent-tiered memory -- L0 conversation turns, L1 atoms, L2 scenarios.",
    parameters: { type: "object", properties: { tier: { type: "string", enum: ["conversation", "atoms", "scenarios"] } }, required: ["tier"] },
    execute: async (args, ctx) => {
      if (args.tier === "conversation") return getConversation(ctx.actorId);
      if (args.tier === "atoms") return getAtoms(ctx.actorId);
      return getScenarios(ctx.actorId);
    },
  },
  {
    name: "check_write_approval",
    description: "Check whether real write-approval mode is on, and list any real pending gated writes.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => ({ enabled: getWriteApprovalSetting(ctx.actorId), pending: listPendingWrites(ctx.actorId) }),
  },
  {
    name: "toggle_write_approval",
    description: "Turn real write-approval mode on/off.",
    parameters: { type: "object", properties: { enabled: { type: "boolean" } }, required: ["enabled"] },
    execute: async (args, ctx) => {
      setWriteApprovalSetting(ctx.actorId, Boolean(args.enabled));
      return { enabled: getWriteApprovalSetting(ctx.actorId) };
    },
  },
  {
    name: "approve_pending_write",
    description: "Approve one real pending gated write by id.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    execute: async (args, ctx) => {
      approveWrite(ctx.actorId, args.id as string);
      return { ok: true };
    },
  },
];
