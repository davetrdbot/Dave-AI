import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(__dirname, "..", "..", "..", "memory");

const MEMORY_FILES = ["MEMORY.md", "USER.md", "ADAPTABILITY.md"] as const;
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
      // Model-visible tool error: says what to do about it without naming internal files, and
      // points at the store that is actually meant to hold durable trading lessons.
      `That write would push your memory to ${size} chars, over its ${budget}-char budget. Memory is deliberately small -- consolidate what's there, or, if this is a durable lesson about markets or your own trading rather than a fact about the user, save it as knowledge instead (knowledge_draft then knowledge_save), which has no size limit.`
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
export function ensureUserMemory(userId: string): void {
  const dir = userDir(userId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  for (const file of MEMORY_FILES) {
    const dest = filePath(userId, file);
    const template = existsSync(templatePath(file)) ? readFileSync(templatePath(file), "utf8") : "";
    if (!existsSync(dest)) {
      writeFileSync(dest, template, "utf8");
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

/* ===============================================================================================
 * Batch memory editing -- ported from Nous Research's Hermes Agent (NousResearch/hermes-agent,
 * tools/memory_tool_store.py), whose memory design this store already follows.
 *
 * The gap this closes: every write path here was APPEND-ONLY (appendUserFact / appendMemoryNote).
 * Once memory reached its budget the model had no way out -- it could not free space and add in
 * the same breath, so the only outcome was a rejected write and a fact silently lost. Hermes
 * solves this with one atomic batch whose budget is checked against the FINAL state only, so a
 * single call can remove two stale entries AND add a new one even though the add alone would
 * overflow. Two supporting ideas come with it, and both are load-bearing:
 *
 *   - a rejection carries the CURRENT ENTRIES, so the model can consolidate in the same turn
 *     without a read tool (memory is already in its prompt; a read call would be a wasted round
 *     trip, which is why neither implementation has one);
 *   - a consecutive-failure cap, because a fragile consolidation that keeps failing must never
 *     eat the turn. Hermes' comment on this is the right instinct: a failed memory side effect
 *     must not block the user's reply.
 * ============================================================================================ */

/** Which budgeted file an operation targets. ADAPTABILITY.md is deliberately excluded -- it is
 *  outside the frozen pair's budget and has its own append-only path. */
export type MemoryTarget = "memory" | "user";

export type MemoryOperation =
  | { action: "add"; target: MemoryTarget; content: string }
  | { action: "replace"; target: MemoryTarget; oldText: string; content: string }
  | { action: "remove"; target: MemoryTarget; oldText: string };

/** Consecutive failed consolidations before the model is told to stop trying this turn. */
export const MAX_CONSOLIDATION_FAILURES = 3;

const consolidationFailures = new Map<string, number>();

/** Called at the start of a real turn so the cap counts failures within one turn, not forever. */
export function resetConsolidationFailures(userId: string): void {
  consolidationFailures.delete(userId);
}

export class MemoryConsolidationStuckError extends Error {
  constructor(attempts: number) {
    super(
      `Memory consolidation has failed ${attempts} times in a row. Stop retrying memory writes -- leave memory as it is and get on with answering. The fact can be saved later.`
    );
    this.name = "MemoryConsolidationStuckError";
  }
}

/** A replace/remove that matched nothing. Carries the entries for the same reason the budget
 *  rejection does: the model can see what IS there and correct itself without another call. */
export class MemoryEntryNotFoundError extends Error {
  constructor(
    public readonly target: MemoryTarget,
    public readonly oldText: string,
    public readonly currentEntries: { memory: string[]; user: string[] }
  ) {
    super(
      `No ${target} entry contains "${oldText}". The entries actually stored are in currentEntries -- use an exact substring of one of those, or switch this operation to an add.`
    );
    this.name = "MemoryEntryNotFoundError";
  }
}

/** Budget rejection that hands back what is actually stored, so the model can fix it in one turn. */
export class MemoryBatchTooLargeError extends Error {
  constructor(
    public readonly size: number,
    public readonly budget: number,
    public readonly currentEntries: { memory: string[]; user: string[] }
  ) {
    super(
      `That batch would leave memory at ${size} chars, over its ${budget}-char budget. Your current entries are listed in currentEntries -- reissue as ONE batch that also removes or shortens enough stale entries to fit, all in this call. ` +
        `If it is a durable lesson about markets or your own trading rather than a fact about the user, save it as knowledge instead (knowledge_draft then knowledge_save), which has no size limit.`
    );
    this.name = "MemoryBatchTooLargeError";
  }
}

function fileFor(target: MemoryTarget): Extract<MemoryFile, "MEMORY.md" | "USER.md"> {
  return target === "user" ? "USER.md" : "MEMORY.md";
}

/** Entries are the "- " bullet lines this store has always written. */
function parseEntries(raw: string): string[] {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim())
    .filter(Boolean);
}

const renderEntries = (entries: string[]): string => entries.map((e) => `- ${e}`).join("\n");

export function readMemoryEntries(userId: string, target: MemoryTarget): string[] {
  ensureUserMemory(userId);
  return parseEntries(readFileSync(filePath(userId, fileFor(target)), "utf8"));
}

export interface MemoryBatchResult {
  applied: number;
  chars: number;
  budget: number;
  usagePercent: number;
  entries: { memory: string[]; user: string[] };
}

/**
 * Applies every operation atomically: nothing is written unless the whole batch succeeds AND the
 * final combined size fits the budget. Ordering matters and is honoured -- removes/replaces earlier
 * in the array free room for adds later in it.
 */
export function applyMemoryOperations(userId: string, operations: MemoryOperation[]): MemoryBatchResult {
  if (operations.length === 0) throw new Error("No operations given -- pass at least one add, replace or remove.");

  const failures = consolidationFailures.get(userId) ?? 0;
  if (failures >= MAX_CONSOLIDATION_FAILURES) throw new MemoryConsolidationStuckError(failures);

  ensureUserMemory(userId);
  const working: Record<MemoryTarget, string[]> = {
    memory: readMemoryEntries(userId, "memory"),
    user: readMemoryEntries(userId, "user"),
  };

  const fail = (err: Error): never => {
    consolidationFailures.set(userId, failures + 1);
    throw err;
  };

  for (const op of operations) {
    const entries = working[op.target];
    if (op.action === "add") {
      const content = op.content.trim();
      if (!content) fail(new Error("An add needs non-empty content."));
      // Exact duplicates are a no-op rather than an error -- re-saving a fact it already knows is
      // harmless, and failing the whole batch over it would lose the operations around it.
      if (!entries.includes(content)) entries.push(content);
      continue;
    }
    const needle = op.oldText.trim();
    if (!needle) fail(new Error(`A ${op.action} needs oldText -- a short unique substring of the entry to act on.`));
    // Whole-entry match first, then substring -- so a short oldText that happens to be contained
    // in a longer entry never shadows the entry it exactly names.
    const exact = entries.indexOf(needle);
    const index = exact >= 0 ? exact : entries.findIndex((e) => e.includes(needle));
    if (index < 0) fail(new MemoryEntryNotFoundError(op.target, needle, working));
    if (op.action === "remove") entries.splice(index, 1);
    else {
      const content = op.content.trim();
      if (!content) fail(new Error("A replace needs non-empty content. Use remove to delete an entry."));
      entries[index] = content;
    }
  }

  // The whole point of the batch: the budget is checked ONCE, against the end state.
  const memoryText = renderEntries(working.memory);
  const userText = renderEntries(working.user);
  const total = memoryText.length + userText.length;
  if (total > FROZEN_PAIR_CHAR_BUDGET) fail(new MemoryBatchTooLargeError(total, FROZEN_PAIR_CHAR_BUDGET, working));

  writeFileSync(filePath(userId, "MEMORY.md"), memoryText, "utf8");
  writeFileSync(filePath(userId, "USER.md"), userText, "utf8");
  consolidationFailures.delete(userId);

  return {
    applied: operations.length,
    chars: total,
    budget: FROZEN_PAIR_CHAR_BUDGET,
    usagePercent: Math.round((total / FROZEN_PAIR_CHAR_BUDGET) * 100),
    entries: working,
  };
}
