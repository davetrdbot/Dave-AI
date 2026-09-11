import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureUserMemory } from "./hermes-store.js";

/**
 * TencentDB-style 4-tier memory pipeline (Step 1.5 / 4.3), layered
 * alongside the Hermes frozen-snapshot pattern (Step 1.4 / 4.1) rather
 * than duplicating it:
 *   L0 Conversation -> raw recent turns (this file)
 *   L1 Atom         -> atomic extracted facts (this file)
 *   L2 Scenario     -> grouped/contextualized episode summaries (this file)
 *   L3 Persona      -> the existing frozen MEMORY.md/USER.md from
 *                       hermes-store.ts IS the L3 tier -- not re-implemented
 *                       here, per the research summary's integration note.
 */

export interface ConversationTurn {
  ts: number;
  role: "user" | "dave" | "worker";
  text: string;
}

export interface Atom {
  ts: number;
  fact: string;
  sourceTs: number;
}

export interface Scenario {
  ts: number;
  summary: string;
  atomCount: number;
}

function tierDir(userId: string): string {
  const dir = join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "memory", userId, "tiers");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function l0Path(userId: string) {
  return join(tierDir(userId), "l0-conversation.jsonl");
}
function l1Path(userId: string) {
  return join(tierDir(userId), "l1-atoms.jsonl");
}
function l2Path(userId: string) {
  return join(tierDir(userId), "l2-scenarios.jsonl");
}

function appendJsonl(path: string, obj: unknown): void {
  appendFileSync(path, JSON.stringify(obj) + "\n", "utf8");
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const results: T[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try {
      results.push(JSON.parse(line) as T);
    } catch {
      // A single truncated/corrupted line (e.g. a crash mid-append)
      // must not take down every future read of this tier -- skip just
      // that line rather than letting JSON.parse's throw propagate and
      // make the whole memory tier permanently unreadable.
      console.error(`[dave-memory] skipping unparseable line in ${path}`);
    }
  }
  return results;
}

/** L0: record one raw conversation turn, unprocessed. */
export function recordTurn(userId: string, role: ConversationTurn["role"], text: string): ConversationTurn {
  ensureUserMemory(userId);
  const turn: ConversationTurn = { ts: Date.now(), role, text };
  appendJsonl(l0Path(userId), turn);
  return turn;
}

export function getConversation(userId: string): ConversationTurn[] {
  return readJsonl<ConversationTurn>(l0Path(userId));
}

export type AtomExtractor = (text: string) => string[];

/**
 * Default L1 extractor: a simple heuristic (not an LLM call) that pulls
 * "I am / my name is / I like / I prefer / I want" style statements out
 * of a raw turn. Pluggable -- Step 8+ should pass an LLM-backed extractor
 * once a real model call site exists; this keeps the tier real and
 * testable without one.
 */
export const defaultAtomExtractor: AtomExtractor = (text) => {
  const patterns = [
    /\bI(?:'m| am) ([^.!?]+)/gi,
    /\bmy name is ([^.!?]+)/gi,
    /\bI (?:like|prefer|want|need) ([^.!?]+)/gi,
  ];
  const facts: string[] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      facts.push(match[0].trim());
    }
  }
  return facts;
};

/** L1: extract atomic facts from a turn and persist them. */
export function extractAtoms(userId: string, turn: ConversationTurn, extractor: AtomExtractor = defaultAtomExtractor): Atom[] {
  const facts = extractor(turn.text);
  const atoms = facts.map((fact) => ({ ts: Date.now(), fact, sourceTs: turn.ts }));
  for (const atom of atoms) appendJsonl(l1Path(userId), atom);
  return atoms;
}

export function getAtoms(userId: string): Atom[] {
  return readJsonl<Atom>(l1Path(userId));
}

/** L2: group a batch of atoms into a scenario/episode summary. */
export function recordScenario(userId: string, summary: string, atomCount: number): Scenario {
  const scenario: Scenario = { ts: Date.now(), summary, atomCount };
  appendJsonl(l2Path(userId), scenario);
  return scenario;
}

export function getScenarios(userId: string): Scenario[] {
  return readJsonl<Scenario>(l2Path(userId));
}

/** Real gap fixed (user: "/reset doesn't do anything... it should delete every fuckin thing"):
 *  the L0/L1/L2 tiers are a real, separate, permanent record -- every raw turn ever recorded,
 *  every extracted fact, every scenario summary -- fully searchable via recall_memory, and a
 *  plain /reset never touched this directory at all. Deletes the whole tiers/ directory for this
 *  user so a "full reset" is genuinely full, not just the three MEMORY.md/USER.md/ADAPTABILITY.md
 *  files. */
export function clearMemoryTiers(userId: string): void {
  rmSync(tierDir(userId), { recursive: true, force: true });
}
