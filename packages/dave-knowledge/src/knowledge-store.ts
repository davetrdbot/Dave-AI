import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Part 3 (B2): a real knowledge-base system, separate from Skills but
 * same structure (title / use-when / content) and same file-backed
 * per-user registry pattern as skill-store.ts. Distinct real behavior
 * per the ask: a draft is NOT a saved knowledge entry -- knowledge_draft
 * only creates a pending draft, and knowledge_save is the separate,
 * explicit approval step that actually commits it. Nothing is
 * queryable via knowledge_list/knowledge_view until it's been saved.
 */
export interface KnowledgeEntry {
  id: string;
  title: string;
  useWhen: string;
  content: string;
  createdAt: number;
}

export interface KnowledgeDraft {
  id: string;
  title: string;
  useWhen: string;
  content: string;
  status: "pending_approval";
  createdAt: number;
}

function entriesPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "knowledge", userId, "entries.json");
}

function draftsPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "knowledge", userId, "drafts.json");
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path: string, value: unknown): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

export class KnowledgeEntryNotFoundError extends Error {
  constructor(id: string) {
    super(`No knowledge entry "${id}" found.`);
    this.name = "KnowledgeEntryNotFoundError";
  }
}

export class KnowledgeDraftNotFoundError extends Error {
  constructor(id: string) {
    super(`No pending knowledge draft "${id}" found -- either it was already saved, or the id is wrong.`);
    this.name = "KnowledgeDraftNotFoundError";
  }
}

export function knowledgeDraft(userId: string, fields: { title: string; useWhen: string; content: string }): KnowledgeDraft {
  const drafts = readJson<KnowledgeDraft[]>(draftsPath(userId), []);
  const draft: KnowledgeDraft = { id: randomBytes(6).toString("hex"), status: "pending_approval", createdAt: Date.now(), ...fields };
  drafts.push(draft);
  writeJson(draftsPath(userId), drafts);
  return draft;
}

export function listKnowledgeDrafts(userId: string): KnowledgeDraft[] {
  return readJson<KnowledgeDraft[]>(draftsPath(userId), []);
}

/** The real approval step -- a draft only becomes a real, listable/viewable knowledge entry here. */
export function knowledgeSave(userId: string, draftId: string): KnowledgeEntry {
  const drafts = readJson<KnowledgeDraft[]>(draftsPath(userId), []);
  const draft = drafts.find((d) => d.id === draftId);
  if (!draft) throw new KnowledgeDraftNotFoundError(draftId);

  const entries = readJson<KnowledgeEntry[]>(entriesPath(userId), []);
  const entry: KnowledgeEntry = { id: draft.id, title: draft.title, useWhen: draft.useWhen, content: draft.content, createdAt: draft.createdAt };
  entries.push(entry);
  writeJson(entriesPath(userId), entries);
  writeJson(draftsPath(userId), drafts.filter((d) => d.id !== draftId));
  return entry;
}

export function knowledgeList(userId: string): KnowledgeEntry[] {
  return readJson<KnowledgeEntry[]>(entriesPath(userId), []);
}

export function knowledgeView(userId: string, id: string): KnowledgeEntry {
  const entry = readJson<KnowledgeEntry[]>(entriesPath(userId), []).find((e) => e.id === id);
  if (!entry) throw new KnowledgeEntryNotFoundError(id);
  return entry;
}

export function knowledgeDelete(userId: string, id: string): void {
  const entries = readJson<KnowledgeEntry[]>(entriesPath(userId), []);
  if (!entries.some((e) => e.id === id)) throw new KnowledgeEntryNotFoundError(id);
  writeJson(entriesPath(userId), entries.filter((e) => e.id !== id));
}
