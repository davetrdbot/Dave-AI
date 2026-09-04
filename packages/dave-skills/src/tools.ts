import { createSkill, listSkills, deleteSkill } from "./skill-store.js";
import { installSkillFromGithub } from "./github-install.js";
import { installSkillsFromJsonl } from "./jsonl-install.js";

/**
 * Update 10: skills management as real agent tools -- "basically what
 * a user can config in settings bot can do it too." Dave can list its
 * own skills, self-create a new one, install from GitHub or a .jsonl
 * upload, and delete a skill it created (permanent ones stay
 * protected by skill-store.ts's own enforcement either way).
 */
export interface SkillToolContext {
  userId: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: SkillToolContext) => Promise<unknown>;
}

export const SKILL_TOOLS: ToolDefinition[] = [
  {
    name: "list_skills",
    description: "List every skill you currently have -- built-in, self-created, or installed.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => listSkills(ctx.userId),
  },
  {
    name: "create_skill",
    description: "Write and save a new skill for yourself -- instructions/knowledge you want to be able to reuse later.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" }, description: { type: "string" }, content: { type: "string" } },
      required: ["name", "description", "content"],
    },
    execute: async (args, ctx) => createSkill(ctx.userId, { name: args.name as string, description: args.description as string, content: args.content as string, source: "self-created" }),
  },
  {
    name: "install_skill_from_github",
    description: "Install a skill from a real GitHub repository (fetches its SKILL.md or README.md).",
    parameters: { type: "object", properties: { repoUrl: { type: "string" } }, required: ["repoUrl"] },
    execute: async (args, ctx) => installSkillFromGithub(ctx.userId, args.repoUrl as string),
  },
  {
    name: "install_skills_from_jsonl",
    description: "Install one or more skills from .jsonl content the user sent -- one skill per line.",
    parameters: { type: "object", properties: { jsonlContent: { type: "string" }, sourceLabel: { type: "string" } }, required: ["jsonlContent"] },
    execute: async (args, ctx) => installSkillsFromJsonl(ctx.userId, args.jsonlContent as string, (args.sourceLabel as string) ?? "uploaded .jsonl"),
  },
  {
    name: "delete_skill",
    description: "Delete a skill by id. Permanent skills (like your own tool-usage skill) are genuinely protected and will refuse.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    execute: async (args, ctx) => {
      deleteSkill(ctx.userId, args.id as string);
      return { ok: true };
    },
  },
];
