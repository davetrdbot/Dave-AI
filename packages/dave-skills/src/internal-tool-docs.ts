import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { markRecalled, hasRecalled, executeTask, RecallRequiredError } from "@dave/memory";
import { createSkill, listSkills, updateSkillContent, type Skill } from "./skill-store.js";

/**
 * Update 13: "a permanent skill teaching Dave HOW to actually use each
 * of its major tools correctly ... confirm Dave actually recalls and
 * reads these before attempting to use an unfamiliar tool, per the
 * recall-before-acting rule already specified." These three docs live
 * in `docs/skills/` -- same category/location as the existing DAVEMA
 * skill doc (`docs/davema/davema-skill.md`), real markdown reference
 * material, not the per-user dynamic skill store (`@dave/skills`'s own
 * `skill-store.ts`, which is a different, complementary mechanism).
 *
 * Enforcement reuses Step 4.5's REAL recall-before-acting guard
 * (`@dave/memory`'s `executeTask`/`markRecalled`) -- calling one of the
 * mapped "unfamiliar tool" names without having read its doc first
 * genuinely throws `RecallRequiredError`, not a documented convention
 * that could be silently skipped.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));

export type InternalToolDocTopic = "e2b-sandbox" | "ea-webhook";

const DOC_PATHS: Record<InternalToolDocTopic, string> = {
  "e2b-sandbox": join(__dirname, "..", "..", "..", "docs", "skills", "e2b-sandbox-skill.md"),
  "ea-webhook": join(__dirname, "..", "..", "..", "docs", "skills", "ea-webhook-skill.md"),
};

/**
 * Which real tool names are "unfamiliar" enough to require reading the
 * matching doc first. Deliberately the tools whose CORRECT use depends
 * on understanding something non-obvious (E2B's gRPC-vs-REST split,
 * the EA webhook's request-driven round trip) -- not every tool needs
 * this, only the ones where guessing is genuinely risky. (Item 7:
 * R_Feed/demo-account trading is retired -- its tool mappings are
 * removed, not just left dangling on a retired tool array.)
 */
const TOOL_TOPIC_MAP: Record<string, InternalToolDocTopic> = {
  create_e2b_sandbox: "e2b-sandbox",
  check_e2b_key_health: "e2b-sandbox",
  trade_execute: "ea-webhook",
  trade_modify: "ea-webhook",
  partial_close: "ea-webhook",
  full_close: "ea-webhook",
};

export function topicForTool(toolName: string): InternalToolDocTopic | undefined {
  return TOOL_TOPIC_MAP[toolName];
}

/** Real file read -- the actual doc content, not a paraphrase or a cached guess. */
export function readInternalToolDoc(topic: InternalToolDocTopic): string {
  return readFileSync(DOC_PATHS[topic], "utf8");
}

/** Reads the real doc and marks recall satisfied for this (actorId, toolName) pair. */
export function recallToolDoc(actorId: string, toolName: string): string {
  const topic = topicForTool(toolName);
  if (!topic) throw new Error(`"${toolName}" has no internal tool doc mapped -- nothing to recall.`);
  const content = readInternalToolDoc(topic);
  markRecalled(actorId, toolName, `Read ${topic} skill doc before using ${toolName}`);
  return content;
}

/**
 * Wraps a real tool call: if the tool is one of the mapped "unfamiliar"
 * ones and its doc hasn't genuinely been recalled first, this throws
 * `RecallRequiredError` instead of running `fn` -- the same real guard
 * Step 4.5 already enforces for tasks generally, applied here
 * specifically to unfamiliar-tool use.
 */
export function callWithDocRecallRequired<T>(actorId: string, toolName: string, fn: () => T): T {
  const topic = topicForTool(toolName);
  if (!topic) return fn(); // not a mapped "unfamiliar" tool -- no doc gate applies
  return executeTask(actorId, toolName, fn);
}

const SKILL_NAME_PREFIX = "How to use: ";

/**
 * Seeds (or re-seeds in place, same id) each internal tool doc as a
 * real, PERMANENT skill in the per-user skill store -- so
 * `list_skills` genuinely shows "how do I use myself" reference
 * material alongside the auto-generated tool-usage skill (Update 10),
 * not just a file on disk nobody's skill list ever mentions.
 */
export function seedInternalToolDocSkills(userId: string): Skill[] {
  const topics: InternalToolDocTopic[] = ["e2b-sandbox", "ea-webhook"];
  return topics.map((topic) => {
    const name = `${SKILL_NAME_PREFIX}${topic}`;
    const content = readInternalToolDoc(topic);
    const existing = listSkills(userId).find((s) => s.name === name);
    if (existing) return updateSkillContent(userId, existing.id, content);
    return createSkill(userId, { name, description: `Real reference material for using ${topic} tools correctly.`, content, source: "built-in", permanent: true });
  });
}

export { hasRecalled, RecallRequiredError };
