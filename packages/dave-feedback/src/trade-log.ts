import type { DaveDatabase } from "@dave/db";
import { writeTradeJournalEntry, type TradeJournalInput } from "@dave/workers";
import { listClosedTradesSince } from "./closed-trade-log.js";

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
  /** Real gap fixed (user, live: "the trade logs it's having problem... it doesn't know when a
   *  tp hit"): the real MT5 ticket this trade opened under -- the join key that lets a later
   *  close event (closed-trade-log.ts, which already carries the same real ticket) correlate
   *  back to why this trade was opened. Optional only for rows logged before this field existed,
   *  or via journal_trade's voluntary "log my reasoning" path that isn't always tied to a fresh
   *  placement. */
  ticket?: string;
  symbol: string;
  direction: "buy" | "sell";
  entryPrice: number;
  sl?: number;
  tp?: number;
  reasoning: string[];
  confluenceScore?: number;
  narrative: string;
  createdAt: number;
  /** Real gap fixed (user, live: "the log worker will give a existing trade comment, so the
   *  trade have comment"): a trade's placement `reason`/`narrative` is a fixed record from open
   *  time -- this is a separate, appendable log the bot (or the log worker) can add to over the
   *  trade's life (e.g. "moved toward breakeven," "price approaching TP"). Each append is
   *  timestamped and joined onto any prior comments, never overwritten. */
  comment?: string;
}

interface TradeLogRow {
  id: string;
  ticket: string | null;
  symbol: string;
  direction: "buy" | "sell";
  entry_price: number;
  sl: number | null;
  tp: number | null;
  reasoning_json: string;
  confluence_score: number | null;
  narrative: string;
  created_at: number;
  comment: string | null;
}

const TABLE = "trade_journal";

function ensureTable(db: DaveDatabase): void {
  db.createTable(TABLE, [
    { name: "ticket", type: "TEXT" },
    { name: "symbol", type: "TEXT" },
    { name: "direction", type: "TEXT" },
    { name: "entry_price", type: "REAL" },
    { name: "sl", type: "REAL" },
    { name: "tp", type: "REAL" },
    { name: "reasoning_json", type: "TEXT" },
    { name: "confluence_score", type: "REAL" },
    { name: "narrative", type: "TEXT" },
    { name: "comment", type: "TEXT" },
  ]);
}

function toEntry(row: TradeLogRow): TradeLogEntry {
  return {
    id: row.id,
    ticket: row.ticket ?? undefined,
    symbol: row.symbol,
    direction: row.direction,
    entryPrice: row.entry_price,
    sl: row.sl ?? undefined,
    tp: row.tp ?? undefined,
    reasoning: JSON.parse(row.reasoning_json),
    confluenceScore: row.confluence_score ?? undefined,
    narrative: row.narrative,
    createdAt: row.created_at,
    comment: row.comment ?? undefined,
  };
}

/** Real insert -- fires Step 16's entity-created event, which is exactly what drives trade-count reflection. */
export function logTrade(db: DaveDatabase, ownerUserId: string, input: TradeJournalInput): string {
  ensureTable(db);
  const narrative = writeTradeJournalEntry(input);
  return db.insert(TABLE, ownerUserId, {
    ticket: input.ticket ?? null,
    symbol: input.symbol,
    direction: input.direction,
    entry_price: input.entryPrice,
    sl: input.sl ?? null,
    tp: input.tp ?? null,
    reasoning_json: JSON.stringify(input.reasoning),
    confluence_score: input.confluenceScore ?? null,
    narrative,
    comment: null,
  });
}

/** Real feature (user, live: "the log worker will give a existing trade comment"): appends a
 *  timestamped note to a still-open trade's record, found by its real ticket. Never overwrites
 *  prior comments -- each new one is joined on, so the full running commentary survives. Returns
 *  false (no throw) when no journal row for this ticket exists, so a bad/unknown ticket is a
 *  normal "nothing to annotate" outcome, not a crash. */
export function appendTradeComment(db: DaveDatabase, ownerUserId: string, ticket: string, comment: string): boolean {
  ensureTable(db);
  const rows = db.query(TABLE, ownerUserId, {}) as unknown as TradeLogRow[];
  const row = rows.find((r) => r.ticket === ticket);
  if (!row) return false;
  const stamped = `[${new Date().toISOString()}] ${comment}`;
  const merged = row.comment ? `${row.comment}\n${stamped}` : stamped;
  return db.update(TABLE, ownerUserId, row.id, { comment: merged });
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

export interface TradeLifecycle extends TradeLogEntry {
  /** "unknown" only for a pre-migration row with no ticket -- never guessed, since there's
   *  genuinely no way to correlate it to a close event without one. */
  status: "open" | "closed" | "unknown";
  closeReason?: "tp" | "sl" | "dave" | "manual";
  closedAt?: number;
  closedPnl?: number;
}

/** Real answer to "did my TP hit" (user, live: "it doesn't know when a tp hit or other... so the
 *  bot any time asked a trade question... it can check logs"). Joins trade_journal with
 *  closed_trade_log by ticket, at query time -- no migration of either table's own meaning,
 *  each keeps its single responsibility (open-facts vs close-facts). */
export function getTradeLifecycle(db: DaveDatabase, ownerUserId: string, opts: { ticket?: string; symbol?: string; sinceTs?: number } = {}): TradeLifecycle[] {
  ensureTable(db);
  const rows = db.query(TABLE, ownerUserId, {}) as unknown as TradeLogRow[];
  let entries = rows.map(toEntry);
  if (opts.ticket !== undefined) entries = entries.filter((e) => e.ticket === opts.ticket);
  if (opts.symbol !== undefined) entries = entries.filter((e) => e.symbol === opts.symbol);
  if (opts.sinceTs !== undefined) entries = entries.filter((e) => e.createdAt >= (opts.sinceTs as number));

  const closedByTicket = new Map(
    listClosedTradesSince(db, ownerUserId, 0)
      .filter((c) => c.ticket !== undefined)
      .map((c) => [c.ticket as string, c])
  );

  return entries.map((entry) => {
    if (!entry.ticket) return { ...entry, status: "unknown" };
    const closed = closedByTicket.get(entry.ticket);
    if (!closed) return { ...entry, status: "open" };
    return { ...entry, status: "closed", closeReason: closed.reason, closedAt: closed.closedAt, closedPnl: closed.pnl };
  });
}
