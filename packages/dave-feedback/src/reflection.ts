import type { DaveDatabase } from "@dave/db";
import { listTradesSince, type TradeLogEntry } from "./trade-log.js";
import { readSkipLog, type SkipEntry } from "./skip-log.js";
import { getPollResultsSince, type FeedbackPollResult } from "./feedback-poll.js";

/**
 * Step 18.2: trade-count-based reflection -- deliberately SEPARATE from
 * the time-based dreaming cron (18.1). N is a real per-user configurable
 * threshold (default 10), not hardcoded. Wired directly to Step 16's
 * real entity-trigger mechanism: every genuine trade insert into the
 * trade journal advances the counter; hitting the threshold fires a
 * real reflection with everything accumulated since the last one.
 *
 * Step 18.5: feedback poll results are gathered into the SAME
 * ReflectionInput passed to the caller's handler -- genuinely
 * referenced, not collected and ignored.
 */

export interface ReflectionInput {
  trades: TradeLogEntry[];
  skips: SkipEntry[];
  pollResults: FeedbackPollResult[];
  sinceTs: number;
}

const SETTINGS_TABLE = "reflection_settings";
const STATE_TABLE = "reflection_state";
export const DEFAULT_TRADE_COUNT_THRESHOLD = 10;

interface SettingsRow {
  id: string;
  trade_count_threshold: number;
}

interface StateRow {
  id: string;
  last_reflected_at: number;
  trades_since_marker: number;
}

function ensureTables(db: DaveDatabase): void {
  db.createTable(SETTINGS_TABLE, [{ name: "trade_count_threshold", type: "INTEGER" }]);
  db.createTable(STATE_TABLE, [
    { name: "last_reflected_at", type: "INTEGER" },
    { name: "trades_since_marker", type: "INTEGER" },
  ]);
}

export function getReflectionThreshold(db: DaveDatabase, ownerUserId: string): number {
  ensureTables(db);
  const rows = db.query(SETTINGS_TABLE, ownerUserId, {}) as unknown as SettingsRow[];
  return rows.length > 0 ? rows[0].trade_count_threshold : DEFAULT_TRADE_COUNT_THRESHOLD;
}

export function setReflectionThreshold(db: DaveDatabase, ownerUserId: string, n: number): void {
  if (n < 1) throw new Error("reflection threshold must be at least 1");
  ensureTables(db);
  const rows = db.query(SETTINGS_TABLE, ownerUserId, {}) as unknown as SettingsRow[];
  if (rows.length > 0) db.update(SETTINGS_TABLE, ownerUserId, rows[0].id, { trade_count_threshold: n });
  else db.insert(SETTINGS_TABLE, ownerUserId, { trade_count_threshold: n });
}

function getOrCreateState(db: DaveDatabase, ownerUserId: string): StateRow {
  ensureTables(db);
  const rows = db.query(STATE_TABLE, ownerUserId, {}) as unknown as StateRow[];
  if (rows.length > 0) return rows[0];
  const id = db.insert(STATE_TABLE, ownerUserId, { last_reflected_at: 0, trades_since_marker: 0 });
  return db.getById(STATE_TABLE, ownerUserId, id) as unknown as StateRow;
}

export function getReflectionState(db: DaveDatabase, ownerUserId: string): { lastReflectedAt: number; tradesSinceMarker: number } {
  const row = getOrCreateState(db, ownerUserId);
  return { lastReflectedAt: row.last_reflected_at, tradesSinceMarker: row.trades_since_marker };
}

/**
 * Subscribes to real trade-journal inserts (Step 16's entity trigger).
 * Returns an unsubscribe function. Every trade for THIS owner advances
 * the counter; once it reaches the configurable threshold, a real
 * reflection fires (awaited) with trades/skips/poll-results gathered
 * since the last reflection, then the marker resets.
 */
export function subscribeTradeCountReflection(db: DaveDatabase, ownerUserId: string, onReflect: (input: ReflectionInput) => void | Promise<void>): () => void {
  ensureTables(db);
  return db.onEntityEvent(async (event) => {
    if (event.table !== "trade_journal" || event.op !== "created" || event.ownerUserId !== ownerUserId) return;

    const state = getOrCreateState(db, ownerUserId);
    const threshold = getReflectionThreshold(db, ownerUserId);
    const newCount = state.trades_since_marker + 1;

    if (newCount >= threshold) {
      const sinceTs = state.last_reflected_at;
      const input: ReflectionInput = {
        trades: listTradesSince(db, ownerUserId, sinceTs),
        skips: readSkipLog(ownerUserId).filter((s) => s.ts >= sinceTs),
        pollResults: getPollResultsSince(db, ownerUserId, sinceTs),
        sinceTs,
      };
      await onReflect(input);
      db.update(STATE_TABLE, ownerUserId, state.id, { last_reflected_at: Date.now(), trades_since_marker: 0 });
    } else {
      db.update(STATE_TABLE, ownerUserId, state.id, { trades_since_marker: newCount });
    }
  });
}
