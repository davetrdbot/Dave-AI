import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Step 10.7: teaching a pattern (video or text) gets saved as a
 * machine-readable .json trading skill. This module is the SYSTEM that
 * stores/loads skills -- it never authors skill content itself (per the
 * master prompt, trading rules/patterns are never Dave's/Claude's to
 * invent). The skill library ships empty; skills only exist once a user
 * actually teaches one.
 */

export interface TradingSkill {
  id: string;
  name: string;
  taughtFrom: "video" | "text";
  description: string;
  rules: unknown; // structure defined by whatever the user taught -- not prescribed here
  createdAt: number;
}

function skillsDir(userId: string): string {
  const dir = join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "skills");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveSkill(userId: string, skill: TradingSkill): void {
  writeFileSync(join(skillsDir(userId), `${skill.id}.json`), JSON.stringify(skill, null, 2), "utf8");
}

export function loadSkill(userId: string, skillId: string): TradingSkill | undefined {
  const p = join(skillsDir(userId), `${skillId}.json`);
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, "utf8"));
}

export function listSkills(userId: string): TradingSkill[] {
  const dir = skillsDir(userId);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}
