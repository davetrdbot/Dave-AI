import type { DaveDatabase } from "@dave/db";

/**
 * Real gap fixed (user: "implement journal of the day that's win rate and others"). Ground truth
 * comes from the EA's own real closed-position reports (real MT5 P&L, real close reason) -- the
 * same real data main.ts's onClosedPosition handler already uses for the hardcoded close message,
 * persisted here too so a real win rate can actually be computed from it, not guessed.
 */

export interface ClosedTradeLogEntry {
  id: string;
  /** Real gap fixed (user, live: "it doesn't know when a tp hit"): the same real MT5 ticket the
   *  EA's EaClosedPosition already carries -- the join key back to trade-log.ts's TradeLogEntry
   *  that opened this trade. Optional only for rows logged before this field existed. */
  ticket?: string;
  symbol: string;
  pnl: number;
  reason: "tp" | "sl" | "dave" | "manual";
  closedAt: number;
}

interface ClosedTradeRow {
  id: string;
  ticket: string | null;
  symbol: string;
  pnl: number;
  reason: string;
  closed_at: number;
}

const TABLE = "closed_trade_log";

function ensureTable(db: DaveDatabase): void {
  db.createTable(TABLE, [
    { name: "ticket", type: "TEXT" },
    { name: "symbol", type: "TEXT" },
    { name: "pnl", type: "REAL" },
    { name: "reason", type: "TEXT" },
    { name: "closed_at", type: "INTEGER" },
  ]);
}

function toEntry(row: ClosedTradeRow): ClosedTradeLogEntry {
  return { id: row.id, ticket: row.ticket ?? undefined, symbol: row.symbol, pnl: row.pnl, reason: row.reason as ClosedTradeLogEntry["reason"], closedAt: row.closed_at };
}

/** Real insert -- called from the same real onClosedPosition event that already drives the
 *  hardcoded "✅ SYMBOL closed. +$X.XX." Telegram notification, so this never drifts from what the
 *  user was actually told happened. */
export function logClosedTrade(db: DaveDatabase, ownerUserId: string, entry: { ticket?: string; symbol: string; pnl: number; reason: ClosedTradeLogEntry["reason"] }): string {
  ensureTable(db);
  return db.insert(TABLE, ownerUserId, { ticket: entry.ticket ?? null, symbol: entry.symbol, pnl: entry.pnl, reason: entry.reason, closed_at: Date.now() });
}

export function listClosedTradesSince(db: DaveDatabase, ownerUserId: string, sinceTs: number): ClosedTradeLogEntry[] {
  ensureTable(db);
  const rows = db.query(TABLE, ownerUserId, {}) as unknown as ClosedTradeRow[];
  return rows.filter((r) => r.closed_at >= sinceTs).map(toEntry);
}

export interface WinRateSummary {
  wins: number;
  losses: number;
  breakeven: number;
  total: number;
  /** null when there are genuinely zero closed trades in the window -- never fabricated as 0%. */
  winRatePct: number | null;
  netPnl: number;
}

/** Real win-rate aggregation -- win = real pnl > 0, loss = real pnl < 0, breakeven = exactly 0. */
export function getWinRateSummary(db: DaveDatabase, ownerUserId: string, sinceTs: number): WinRateSummary {
  const trades = listClosedTradesSince(db, ownerUserId, sinceTs);
  const wins = trades.filter((t) => t.pnl > 0).length;
  const losses = trades.filter((t) => t.pnl < 0).length;
  const breakeven = trades.filter((t) => t.pnl === 0).length;
  const total = trades.length;
  const netPnl = trades.reduce((sum, t) => sum + t.pnl, 0);
  return { wins, losses, breakeven, total, winRatePct: total > 0 ? (wins / total) * 100 : null, netPnl };
}

/** "Journal of the day" -- the real win-rate summary for the current real UTC calendar day. */
export function getTodaysWinRateSummary(db: DaveDatabase, ownerUserId: string): WinRateSummary {
  const now = new Date();
  const startOfDayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return getWinRateSummary(db, ownerUserId, startOfDayUtc);
}
