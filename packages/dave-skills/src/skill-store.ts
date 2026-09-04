import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Update 10: "you are supposed to create a permanent skill teaching
 * the agent to use it's tools and others and also self create it's own
 * skills and can Install any skill from GitHub or I can send it .jsonl
 * it will automatically detect it as skill ... and I can delete skill
 * and others." A skill is real, stored instructional content Dave can
 * be given (a "PERMANENT" tool-usage skill seeded for every user,
 * never deletable), can write for itself, or a user can install from
 * GitHub or a .jsonl upload -- same file-backed-registry pattern as
 * every other per-user store in this build (worker-factory.ts,
 * tool-requests.ts, etc).
 */

export type SkillSource = "built-in" | "self-created" | "github" | "jsonl-upload";

export interface Skill {
  id: string;
  name: string;
  description: string;
  content: string;
  source: SkillSource;
  permanent: boolean;
  createdAt: number;
}

function registryPath(userId: string): string {
  return join(process.cwd(), "data", "skills", userId, "registry.json");
}

function readRegistry(userId: string): Skill[] {
  const path = registryPath(userId);
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveRegistry(userId: string, skills: Skill[]): void {
  const path = registryPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(skills, null, 2), "utf8");
}

export class DuplicateSkillNameError extends Error {
  constructor(name: string) {
    super(`A skill named "${name}" already exists for this user.`);
    this.name = "DuplicateSkillNameError";
  }
}

export class SkillNotFoundError extends Error {
  constructor(id: string) {
    super(`No skill "${id}" found.`);
    this.name = "SkillNotFoundError";
  }
}

export class PermanentSkillError extends Error {
  constructor(name: string) {
    super(`"${name}" is a permanent skill and cannot be deleted.`);
    this.name = "PermanentSkillError";
  }
}

export interface CreateSkillInput {
  name: string;
  description: string;
  content: string;
  source: SkillSource;
  permanent?: boolean;
}

export function createSkill(userId: string, input: CreateSkillInput): Skill {
  const skills = readRegistry(userId);
  if (skills.some((s) => s.name === input.name)) throw new DuplicateSkillNameError(input.name);
  const skill: Skill = {
    id: randomBytes(6).toString("hex"),
    name: input.name,
    description: input.description,
    content: input.content,
    source: input.source,
    permanent: input.permanent ?? false,
    createdAt: Date.now(),
  };
  skills.push(skill);
  saveRegistry(userId, skills);
  return skill;
}

export function listSkills(userId: string): Skill[] {
  return readRegistry(userId);
}

export function getSkill(userId: string, id: string): Skill | undefined {
  return readRegistry(userId).find((s) => s.id === id);
}

/** Real, persisted content update (e.g. re-generating the tool-usage skill as the tool set changes). */
export function updateSkillContent(userId: string, id: string, content: string): Skill {
  const skills = readRegistry(userId);
  const skill = skills.find((s) => s.id === id);
  if (!skill) throw new SkillNotFoundError(id);
  skill.content = content;
  saveRegistry(userId, skills);
  return skill;
}

/** Real enforcement: a permanent skill genuinely cannot be deleted, by anyone -- not a UI convention. */
export function deleteSkill(userId: string, id: string): void {
  const skills = readRegistry(userId);
  const skill = skills.find((s) => s.id === id);
  if (!skill) throw new SkillNotFoundError(id);
  if (skill.permanent) throw new PermanentSkillError(skill.name);
  saveRegistry(userId, skills.filter((s) => s.id !== id));
}
