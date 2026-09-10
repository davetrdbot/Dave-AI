import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(__dirname, "..", "..", "..", "memory");

const MEMORY_FILES = ["MEMORY.md", "USER.md", "ADAPTABILITY.md", "goal.yaml"] as const;
type MemoryFile = (typeof MEMORY_FILES)[number];

/**
 * Combined char budget for MEMORY.md + USER.md, mirroring the Hermes Agent
 * pattern researched in Step 1.4 (~1,300 tokens ~= this many chars at a
 * rough 4-chars/token estimate). ADAPTABILITY.md and goal.yaml are not
 * counted — they serve different purposes and aren't part of the frozen
 * identity/fact pair the cap protects.
 */
export const FROZEN_PAIR_CHAR_BUDGET = 5200;

export class MemoryBudgetExceededError extends Error {
  constructor(file: MemoryFile, size: number, budget: number) {
    super(
      `Writing to ${file} would push MEMORY.md+USER.md to ${size} chars, over the ${budget}-char budget. Consolidate before writing more.`
    );
    this.name = "MemoryBudgetExceededError";
  }
}

export interface FrozenSnapshot {
  readonly userId: string;
  readonly loadedAt: number;
  readonly memory: string;
  readonly user: string;
  readonly adaptability: string;
  readonly goal: string;
}

/**
 * Real bug fixed (user: "I gave you the goal.yaml, why it still asking me" -- the admin panel
 * runs as its own real child process with its OWN process.cwd() (packages/dave-admin, see
 * main.ts's spawnAdminPanel), so a goal.yaml genuinely submitted through the admin panel's real
 * /api/goal-config route was written to a completely different file than the one the bot process
 * reads -- same class of bug DATA_DIR already fixed for the database (db-path.ts). MEMORY_DATA_DIR
 * is the same real fix for this package: both processes now genuinely read/write the identical
 * file when it's set (main.ts sets it when spawning the admin panel); unset (a bare local dev run,
 * or any other caller) keeps the exact prior behavior.
 */
function memoryRoot(): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "memory");
}

function userDir(userId: string): string {
  return join(memoryRoot(), userId);
}

function templatePath(file: MemoryFile): string {
  return join(TEMPLATE_DIR, file);
}

function filePath(userId: string, file: MemoryFile): string {
  return join(userDir(userId), file);
}

/**
 * Real gap fixed (user: "I remember I gave you my goal.yaml... add it to the bot file so they
 * will be no need to paste in admin panel"): the repo's own template goal.yaml is no longer the
 * empty placeholder -- it's the user's own real, provided trading rules -- so a fresh account now
 * gets it seeded automatically, no admin-panel paste needed at all. This ALSO re-seeds an
 * EXISTING live goal.yaml if it's still genuinely the old empty placeholder (the exact real bug
 * this session found and fixed: the admin panel's writes never reached this file at all, so a
 * live account stuck on the placeholder needs this same fix applied retroactively, without a
 * restart or manual replay). Never touches a goal.yaml that's been genuinely customized -- only
 * an exact match against the known-empty placeholder marker is replaced.
 */
const EMPTY_GOAL_PLACEHOLDER_MARKER = "# Empty placeholder. This file is never authored by Claude/Dave.";

export function ensureUserMemory(userId: string): void {
  const dir = userDir(userId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  for (const file of MEMORY_FILES) {
    const dest = filePath(userId, file);
    const template = existsSync(templatePath(file)) ? readFileSync(templatePath(file), "utf8") : "";
    if (!existsSync(dest)) {
      writeFileSync(dest, template, "utf8");
    } else if (file === "goal.yaml") {
      const current = readFileSync(dest, "utf8");
      if (current.trim() === "" || current.includes(EMPTY_GOAL_PLACEHOLDER_MARKER)) {
        writeFileSync(dest, template, "utf8");
      }
    }
  }
}

/**
 * Item 8 (/reset "Delete all memory files (MEMORY.md, USER.md, ADAPTABILITY.md) back to
 * empty"). Deliberately excludes goal.yaml -- item 9 made Dave's real trading behavior built in
 * (prompts/trading.md), but a user may still have an optional goal.yaml override set through the
 * admin panel; that's real authored content they'd have to redo from scratch, not conversational
 * memory, so a chat-level /reset leaves it alone.
 */
export function resetUserMemory(userId: string): void {
  const dir = userDir(userId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  for (const file of ["MEMORY.md", "USER.md", "ADAPTABILITY.md"] as const) {
    const template = existsSync(templatePath(file)) ? readFileSync(templatePath(file), "utf8") : "";
    writeFileSync(filePath(userId, file), template, "utf8");
  }
}

/**
 * Loads a FROZEN snapshot of this user's memory files. Per the Hermes
 * pattern (Step 1.4), this snapshot is meant to be read once at session
 * start and placed first in the prompt (static-first, per Step 1.7) — it
 * intentionally does NOT reflect writes made during the session. Callers
 * that write mid-session should re-load on the *next* session.
 */
export function loadFrozenSnapshot(userId: string): FrozenSnapshot {
  ensureUserMemory(userId);
  const read = (file: MemoryFile) => readFileSync(filePath(userId, file), "utf8");
  return Object.freeze({
    userId,
    loadedAt: Date.now(),
    memory: read("MEMORY.md"),
    user: read("USER.md"),
    adaptability: read("ADAPTABILITY.md"),
    goal: read("goal.yaml"),
  });
}

/**
 * Appends a fact to USER.md immediately (per BOOTSTRAP.md: "save
 * immediately after each answer" — not optional, not deferred). Enforces
 * the combined MEMORY.md+USER.md char budget before writing.
 */
export function appendUserFact(userId: string, fact: string): void {
  appendToBudgetedFile(userId, "USER.md", fact);
}

/** Appends a lasting general observation/fact to MEMORY.md immediately (budget-enforced, same as appendUserFact). */
export function appendMemoryNote(userId: string, note: string): void {
  appendToBudgetedFile(userId, "MEMORY.md", note);
}

/** Appends a communication-style/tone preference to ADAPTABILITY.md immediately. */
export function appendAdaptability(userId: string, note: string): void {
  ensureUserMemory(userId);
  const path = filePath(userId, "ADAPTABILITY.md");
  const current = readFileSync(path, "utf8");
  const next = current.length ? `${current}\n- ${note}` : `- ${note}`;
  writeFileSync(path, next, "utf8");
}

function appendToBudgetedFile(userId: string, file: Extract<MemoryFile, "MEMORY.md" | "USER.md">, line: string): void {
  ensureUserMemory(userId);
  const memoryPath = filePath(userId, "MEMORY.md");
  const userPath = filePath(userId, "USER.md");
  const memoryCurrent = readFileSync(memoryPath, "utf8");
  const userCurrent = readFileSync(userPath, "utf8");

  const targetPath = filePath(userId, file);
  const targetCurrent = file === "MEMORY.md" ? memoryCurrent : userCurrent;
  const nextTarget = targetCurrent.length ? `${targetCurrent}\n- ${line}` : `- ${line}`;

  const otherLength = file === "MEMORY.md" ? userCurrent.length : memoryCurrent.length;
  const projectedTotal = nextTarget.length + otherLength;
  if (projectedTotal > FROZEN_PAIR_CHAR_BUDGET) {
    throw new MemoryBudgetExceededError(file, projectedTotal, FROZEN_PAIR_CHAR_BUDGET);
  }

  writeFileSync(targetPath, nextTarget, "utf8");
}

/** For tests/inspection only — reads the live (non-frozen) current file content. */
export function readLive(userId: string, file: MemoryFile): string {
  ensureUserMemory(userId);
  return readFileSync(filePath(userId, file), "utf8");
}

/**
 * Item 12: writes the user's own real goal.yaml content directly (the user's own stated
 * trading goals/principles, not agent-invented content) -- previously there was no writer at
 * all, only readLive()/get_goal_config's read side.
 */
export function writeLive(userId: string, file: MemoryFile, content: string): void {
  ensureUserMemory(userId);
  writeFileSync(filePath(userId, file), content, "utf8");
}
