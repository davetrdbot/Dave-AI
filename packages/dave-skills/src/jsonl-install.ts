import { createSkill, type Skill } from "./skill-store.js";

/**
 * Update 10: "I can send it .jsonl it will automatically detect it as
 * skill." One skill record per non-empty line (real JSONL semantics --
 * not a single JSON blob). A malformed line is a real, reported error,
 * never silently dropped.
 */
export function isJsonlSkillFile(filename: string): boolean {
  return filename.toLowerCase().endsWith(".jsonl");
}

export interface JsonlSkillLine {
  name: string;
  description?: string;
  content: string;
}

export interface JsonlInstallResult {
  installed: Skill[];
  errors: { line: number; message: string }[];
}

function parseLine(line: string, lineNumber: number): JsonlSkillLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`line ${lineNumber}: not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`line ${lineNumber}: expected a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.name !== "string" || obj.name.trim() === "") {
    throw new Error(`line ${lineNumber}: missing required "name" field`);
  }
  if (typeof obj.content !== "string" || obj.content.trim() === "") {
    throw new Error(`line ${lineNumber}: missing required "content" field`);
  }
  return { name: obj.name, description: typeof obj.description === "string" ? obj.description : undefined, content: obj.content };
}

export function installSkillsFromJsonl(userId: string, jsonlContent: string, sourceLabel: string): JsonlInstallResult {
  const lines = jsonlContent.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const installed: Skill[] = [];
  const errors: { line: number; message: string }[] = [];

  lines.forEach((line, i) => {
    const lineNumber = i + 1;
    try {
      const parsed = parseLine(line, lineNumber);
      const skill = createSkill(userId, {
        name: parsed.name,
        description: parsed.description ?? `Installed from ${sourceLabel}, line ${lineNumber}`,
        content: parsed.content,
        source: "jsonl-upload",
      });
      installed.push(skill);
    } catch (err) {
      errors.push({ line: lineNumber, message: err instanceof Error ? err.message : String(err) });
    }
  });

  return { installed, errors };
}
