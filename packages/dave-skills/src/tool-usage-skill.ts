import type { ToolSpec } from "@dave/brain";
import { createSkill, listSkills, updateSkillContent, type Skill } from "./skill-store.js";

/**
 * Update 10: "a permanent skill teaching the agent to use it's tools."
 * Generated FROM the real, currently-registered tool specs (whatever
 * dave-agent-loop's `ToolRegistry.toSpecs()` returns) -- never a
 * hand-maintained list that drifts from what's actually registered.
 * Seeded once per user, `permanent: true` (skill-store.ts's own
 * deletion guard enforces it can't be removed).
 */
export const TOOL_USAGE_SKILL_NAME = "Using Your Tools";

export function generateToolUsageContent(tools: ToolSpec[]): string {
  if (tools.length === 0) {
    return "You currently have no tools registered. Ask the user or check your setup before assuming a capability exists.";
  }
  const lines = tools
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => `- **${t.name}**: ${t.description}`);
  return [
    "You have real, callable tools -- use them instead of guessing or claiming you can't do something a tool below actually covers.",
    "Before answering from memory, check whether one of these tools would give a more current or verifiable answer.",
    "If a task genuinely needs a tool you don't have, use `request_tool` to ask for it rather than getting stuck or pretending you handled it.",
    "",
    "Your current tools:",
    ...lines,
  ].join("\n");
}

/** Seeds (or re-seeds, keeping the same skill id) the permanent tool-usage skill for this user. */
export function seedToolUsageSkill(userId: string, tools: ToolSpec[]): Skill {
  const existing = listSkills(userId).find((s) => s.name === TOOL_USAGE_SKILL_NAME);
  const content = generateToolUsageContent(tools);
  if (existing) {
    // Re-generated and persisted in place rather than duplicated -- the
    // registered tool set can change over time, so this skill's content
    // is not treated as immutable.
    return updateSkillContent(userId, existing.id, content);
  }
  return createSkill(userId, { name: TOOL_USAGE_SKILL_NAME, description: "How to use your real, currently-registered tools.", content, source: "built-in", permanent: true });
}
