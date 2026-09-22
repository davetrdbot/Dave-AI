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
    description:
      "List every skill you have -- id, name, what it's for, and how big it is. This is an INDEX, not the skills themselves: to actually read one, call skill_view with its id.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => {
      // Real token bug fixed: this used to return listSkills() verbatim, and a Skill carries its
      // whole `content`. So one call to a CORE tool whose description merely said "list your
      // skills" dumped every skill's entire body into the conversation -- with a handful of real
      // strategy skills that is tens of thousands of characters, paid for on a call the model
      // makes casually, to answer "what skills do I have". Hermes draws this line explicitly
      // (skills_list = name/description; skill_view = content) and it is the right one: an index
      // is for choosing, the content is for using.
      const active = getActiveStrategySkillId(ctx.userId);
      return listSkills(ctx.userId).map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        source: s.source,
        permanent: s.permanent,
        active: s.id === active,
        // Honest about what is NOT here, and roughly what reading it would cost.
        contentChars: s.content.length,
      }));
    },
  },
  {
    // Real gap fixed (looking at Hermes's skill_view against Dave's skill tools): Dave had NO way
    // to read a skill's content at all. He could list skills (name + description), and he could
    // ACTIVATE one -- which injects its content every turn -- but there was nothing in between.
    //
    // That left two real failures. "What does my Sniper strategy actually say about stops?" was
    // unanswerable unless that skill happened to be active. And deciding whether a skill fits the
    // situation in front of him -- the whole point of showing the index every turn -- had to be
    // done from a one-line description, because the only way to see more was to activate it, which
    // is the trader's call alone and changes how every trade is taken.
    name: "skill_view",
    description:
      "Read one skill's full content, by id or name. The index you see every turn gives you names and one-line descriptions; this is how you actually read one. " +
      "Use it before offering a skill (so you know what you're offering), to answer a question about what a strategy says, or to check what a skill covers before writing a new one that might overlap. " +
      "Reading a skill does NOT activate it and changes nothing about how you trade -- activation stays the trader's call.",
    parameters: {
      type: "object",
      properties: { skill: { type: "string", description: "The skill's id (from list_skills) or its exact name." } },
      required: ["skill"],
    },
    execute: async (args, ctx) => {
      const key = (args.skill as string).trim();
      const skills = listSkills(ctx.userId);
      const skill = skills.find((s) => s.id === key) ?? skills.find((s) => s.name.toLowerCase() === key.toLowerCase());
      if (!skill) {
        throw new Error(`No skill "${key}" found. Call list_skills for the real ids and names.`);
      }
      // Adapted from Hermes's repeat-view dedup, whose point is that re-serving content the model
      // already has in front of it is pure waste. Dave's version of that is simpler and needs no
      // cache: the ACTIVE skill's full content is injected into the live context on every single
      // turn, so viewing it would put the same text in the same request twice.
      if (getActiveStrategySkillId(ctx.userId) === skill.id) {
        return {
          id: skill.id,
          name: skill.name,
          description: skill.description,
          contentReturned: false,
          reason:
            "This is your ACTIVE strategy skill, so its full content is already in front of you this turn, under <active_strategy_skill>. Read it there rather than loading a second copy.",
        };
      }
      return { id: skill.id, name: skill.name, description: skill.description, source: skill.source, active: false, content: skill.content };
    },
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
