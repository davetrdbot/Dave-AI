import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { writeTradeJournalEntry, type TradeJournalInput } from "./journal-worker.js";

/**
 * Update 18: a real, persisted journal store -- `writeTradeJournalEntry`
 * (Step 12) only ever formatted text, nothing stored it. `journal_trade`/
 * `journal_close`/`journal_daily`/`journal_search` need real entries to
 * operate on.
 */
export interface JournalEntry {
  id: string;
  narrative: string;
  input: TradeJournalInput;
  closedAt?: number;
  closeNote?: string;
  /** Real P&L at close, in account currency -- the actual number, not inferred from prose. */
  pnl?: number;
  createdAt: number;
}

function storePath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "workers", userId, "journal.json");
}

function readEntries(userId: string): JournalEntry[] {
  const path = storePath(userId);
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveEntries(userId: string, entries: JournalEntry[]): void {
  const path = storePath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(entries, null, 2), "utf8");
}

export function journalTrade(userId: string, input: TradeJournalInput): JournalEntry {
  const entries = readEntries(userId);
  const entry: JournalEntry = { id: randomBytes(6).toString("hex"), narrative: writeTradeJournalEntry(input), input, createdAt: Date.now() };
  entries.push(entry);
  saveEntries(userId, entries);
  return entry;
}

export function journalClose(userId: string, entryId: string, closeNote: string, pnl?: number): JournalEntry {
  const entries = readEntries(userId);
  const entry = entries.find((e) => e.id === entryId);
  if (!entry) throw new Error(`no journal entry "${entryId}"`);
  entry.closedAt = Date.now();
  entry.closeNote = closeNote;
  entry.pnl = pnl;
  saveEntries(userId, entries);
  return entry;
}

/** Real, exported listing -- the admin analytics endpoints need every entry, not just a day/search slice. */
export function listJournalEntries(userId: string): JournalEntry[] {
  return readEntries(userId);
}

export function journalDaily(userId: string, dayStart: number, dayEnd: number): JournalEntry[] {
  return readEntries(userId).filter((e) => e.createdAt >= dayStart && e.createdAt < dayEnd);
}

export function journalSearch(userId: string, query: string): JournalEntry[] {
  const q = query.toLowerCase();
  return readEntries(userId).filter((e) => e.narrative.toLowerCase().includes(q) || e.input.symbol.toLowerCase().includes(q));
}
