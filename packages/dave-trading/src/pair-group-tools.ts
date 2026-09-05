import { upsertGroup, deleteGroup, listGroups, getActiveGroupInfo, type PairGroup } from "./pair-groups.js";

/**
 * Update 17 (settings audit): pair groups had a real admin UI (Step
 * 14) but only `set_active_pair_group`/fallback existed as an agent
 * tool -- create/edit/delete/list a group was admin-UI-only. Full
 * parity now: everything a user can do in the admin panel, Dave can
 * also do as a real tool call.
 */
export interface PairGroupToolContext {
  userId: string;
}

export interface PairGroupToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: PairGroupToolContext) => Promise<unknown>;
}

export const PAIR_GROUP_TOOLS: PairGroupToolDefinition[] = [
  {
    name: "list_pair_groups",
    description: "List every pair group the user has defined, plus which is active/fallback.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => ({ groups: listGroups(ctx.userId), active: getActiveGroupInfo(ctx.userId) }),
  },
  {
    name: "create_or_update_pair_group",
    description: "Create a new pair group or update an existing one's name/symbols (same id = update in place).",
    parameters: {
      type: "object",
      properties: { id: { type: "string" }, name: { type: "string" }, symbols: { type: "array", items: { type: "string" } } },
      required: ["id", "name", "symbols"],
    },
    execute: async (args, ctx) => {
      const group: PairGroup = { id: args.id as string, name: args.name as string, symbols: args.symbols as string[] };
      upsertGroup(ctx.userId, group);
      return group;
    },
  },
  {
    name: "delete_pair_group",
    description: "Delete a pair group by id.",
    parameters: { type: "object", properties: { groupId: { type: "string" } }, required: ["groupId"] },
    execute: async (args, ctx) => {
      deleteGroup(ctx.userId, args.groupId as string);
      return { ok: true };
    },
  },
  {
    name: "get_active_pair_group",
    description: "Get the real current active/fallback pair group state, including whether it's paused for extreme conditions. To CHANGE which group is active/fallback, use set_active_pair_group.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => getActiveGroupInfo(ctx.userId),
  },
];
