import { knowledgeDraft, knowledgeSave, knowledgeList, knowledgeView, knowledgeDelete, listKnowledgeDrafts } from "./knowledge-store.js";

export interface KnowledgeToolContext {
  userId: string;
}

export interface KnowledgeToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: KnowledgeToolContext) => Promise<unknown>;
}

export const KNOWLEDGE_TOOLS: KnowledgeToolDefinition[] = [
  {
    name: "knowledge_list",
    description: "List every real, SAVED knowledge entry (title/use-when) -- pending drafts don't show up here until approved.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => knowledgeList(ctx.userId),
  },
  {
    name: "knowledge_view",
    description: "View the full content of one saved knowledge entry by id.",
    parameters: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    execute: async (args, ctx) => knowledgeView(ctx.userId, args.id as string),
  },
  {
    name: "knowledge_draft",
    description: "Draft a new knowledge entry (title/use-when/content) -- NOT saved yet, requires knowledge_save to actually commit it.",
    parameters: {
      type: "object",
      required: ["title", "useWhen", "content"],
      properties: { title: { type: "string" }, useWhen: { type: "string" }, content: { type: "string" } },
    },
    execute: async (args, ctx) => knowledgeDraft(ctx.userId, { title: args.title as string, useWhen: args.useWhen as string, content: args.content as string }),
  },
  {
    name: "knowledge_save",
    description: "Approve and commit a pending draft (by id) -- only after this does it show up in knowledge_list/knowledge_view.",
    parameters: { type: "object", required: ["draftId"], properties: { draftId: { type: "string" } } },
    execute: async (args, ctx) => knowledgeSave(ctx.userId, args.draftId as string),
  },
  {
    name: "knowledge_delete",
    description: "Permanently delete a saved knowledge entry by id.",
    parameters: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    execute: async (args, ctx) => {
      knowledgeDelete(ctx.userId, args.id as string);
      return { deleted: true };
    },
  },
  {
    name: "list_knowledge_drafts",
    description: "List pending, not-yet-saved knowledge drafts awaiting approval.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => listKnowledgeDrafts(ctx.userId),
  },
];
