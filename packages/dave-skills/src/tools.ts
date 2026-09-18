import { createSkill, listSkills, deleteSkill, getSkill } from "./skill-store.js";
import { installSkillFromGithub } from "./github-install.js";
import { installSkillsFromJsonl } from "./jsonl-install.js";
import { getActiveStrategySkillId, setActiveStrategySkill, clearActiveStrategySkill } from "@dave/trading";

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
    name: "set_active_strategy_skill",
    description:
      "Mark one of your skills as the active trading strategy. Skills are trading-strategy-only (which timeframes/tools/signals to use and when) -- once active, that skill's instructions become the real analysis lens for every trade cycle, followed explicitly per your own trading rules, replacing your own default judgment until cleared. Only call this when the user explicitly tells you to activate a specific skill -- never pick or switch a strategy on your own, and never ask the user to choose one; if they haven't told you to activate anything, leave whatever is already active (or nothing) alone.",
    parameters: { type: "object", properties: { skillId: { type: "string" } }, required: ["skillId"] },
    execute: async (args, ctx) => {
      const skillId = args.skillId as string;
      const skill = getSkill(ctx.userId, skillId);
      if (!skill) throw new Error(`No skill "${skillId}" found -- call list_skills to see real, valid ids.`);
      setActiveStrategySkill(ctx.userId, skillId);
      return { ok: true, activeStrategySkillId: skillId, name: skill.name };
    },
  },
  {
    name: "clear_active_strategy_skill",
    description: "Clear the active trading-strategy skill. With none active, trading falls back to your own genuine judgment and default analysis lens -- no strategy is ever required.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => {
      clearActiveStrategySkill(ctx.userId);
      return { ok: true };
    },
  },
  {
    name: "get_active_strategy_skill",
    description: "Get whichever skill is currently marked as the active trading strategy, if any.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => {
      const skillId = getActiveStrategySkillId(ctx.userId);
      if (!skillId) return { active: false };
      const skill = getSkill(ctx.userId, skillId);
      return { active: true, skillId, name: skill?.name, description: skill?.description };
    },
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
