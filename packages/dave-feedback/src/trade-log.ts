import type { DaveDatabase } from "@dave/db";
import { writeTradeJournalEntry, type TradeJournalInput } from "@dave/workers";

/**
 * Real gap found while building this step: Step 12's
 * `writeTradeJournalEntry()` only ever formatted a narrative string and
 * returned it -- nothing in the repo persisted it anywhere, so there
 * was no actual per-user trade history to count trades against for
 * 18.2's "trade-count-based reflection". This module is that missing
 * persistence layer, built on Step 16's real DB rather than a new file
 * format -- and it reuses `writeTradeJournalEntry` for the narrative
 * rather than re-implementing it.
 */

export interface TradeLogEntry {
  id: string;
  symbol: string;
  direction: "buy" | "sell";
  entryPrice: number;
  sl?: number;
  tp?: number;
  reasoning: string[];
  confluenceScore?: number;
  narrative: string;
  createdAt: number;
}

interface TradeLogRow {
  id: string;
  symbol: string;
  direction: "buy" | "sell";
  entry_price: number;
  sl: number | null;
  tp: number | null;
  reasoning_json: string;
  confluence_score: number | null;
  narrative: string;
  created_at: number;
}

const TABLE = "trade_journal";

function ensureTable(db: DaveDatabase): void {
  db.createTable(TABLE, [
    { name: "symbol", type: "TEXT" },
    { name: "direction", type: "TEXT" },
    { name: "entry_price", type: "REAL" },
    { name: "sl", type: "REAL" },
    { name: "tp", type: "REAL" },
    { name: "reasoning_json", type: "TEXT" },
    { name: "confluence_score", type: "REAL" },
    { name: "narrative", type: "TEXT" },
  ]);
}

function toEntry(row: TradeLogRow): TradeLogEntry {
  return {
    id: row.id,
    symbol: row.symbol,
    direction: row.direction,
    entryPrice: row.entry_price,
    sl: row.sl ?? undefined,
    tp: row.tp ?? undefined,
    reasoning: JSON.parse(row.reasoning_json),
    confluenceScore: row.confluence_score ?? undefined,
    narrative: row.narrative,
    createdAt: row.created_at,
  };
}

/** Real insert -- fires Step 16's entity-created event, which is exactly what drives trade-count reflection. */
export function logTrade(db: DaveDatabase, ownerUserId: string, input: TradeJournalInput): string {
  ensureTable(db);
  const narrative = writeTradeJournalEntry(input);
  return db.insert(TABLE, ownerUserId, {
    symbol: input.symbol,
    direction: input.direction,
    entry_price: input.entryPrice,
    sl: input.sl ?? null,
    tp: input.tp ?? null,
    reasoning_json: JSON.stringify(input.reasoning),
    confluence_score: input.confluenceScore ?? null,
    narrative,
  });
}

export function listTradesSince(db: DaveDatabase, ownerUserId: string, sinceTs: number): TradeLogEntry[] {
  ensureTable(db);
  const rows = db.query(TABLE, ownerUserId, {}) as unknown as TradeLogRow[];
  return rows.filter((r) => r.created_at >= sinceTs).map(toEntry);
}

export function countTrades(db: DaveDatabase, ownerUserId: string): number {
  ensureTable(db);
  return db.aggregate(TABLE, ownerUserId, "COUNT");
}
