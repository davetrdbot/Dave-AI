import type { DaveDatabase } from "@dave/db";

/**
 * Step 19.1: circuit breaker -- 3 consecutive errors auto-pauses and
 * reports clearly. Built on Step 16's real DB so the trip state
 * genuinely persists across a restart (a crash loop shouldn't reset
 * the counter and let a broken strategy keep firing).
 */

export const TRIP_THRESHOLD = 3;

export interface CircuitBreakerReport {
  tripped: boolean;
  consecutiveErrors: number;
  recentErrors: string[];
  trippedAt?: number;
}

interface StateRow {
  id: string;
  consecutive_errors: number;
  tripped: number;
  recent_errors_json: string;
  tripped_at: number | null;
}

const TABLE = "circuit_breaker_state";

function ensureTable(db: DaveDatabase): void {
  db.createTable(TABLE, [
    { name: "consecutive_errors", type: "INTEGER" },
    { name: "tripped", type: "INTEGER" },
    { name: "recent_errors_json", type: "TEXT" },
    { name: "tripped_at", type: "INTEGER" },
  ]);
}

function getOrCreateState(db: DaveDatabase, ownerUserId: string): StateRow {
  ensureTable(db);
  const rows = db.query(TABLE, ownerUserId, {}) as unknown as StateRow[];
  if (rows.length > 0) return rows[0];
  const id = db.insert(TABLE, ownerUserId, { consecutive_errors: 0, tripped: 0, recent_errors_json: "[]", tripped_at: null });
  return db.getById(TABLE, ownerUserId, id) as unknown as StateRow;
}

function toReport(row: StateRow): CircuitBreakerReport {
  return {
    tripped: row.tripped === 1,
    consecutiveErrors: row.consecutive_errors,
    recentErrors: JSON.parse(row.recent_errors_json),
    trippedAt: row.tripped_at ?? undefined,
  };
}

/** A success resets the counter -- but deliberately does NOT auto-clear an already-tripped breaker (see resetCircuitBreaker). */
export function recordSuccess(db: DaveDatabase, ownerUserId: string): void {
  const state = getOrCreateState(db, ownerUserId);
  db.update(TABLE, ownerUserId, state.id, { consecutive_errors: 0, recent_errors_json: "[]" });
}

/** Real trip logic: hits exactly TRIP_THRESHOLD consecutive errors, no more, no fewer, and never un-trips itself on its own. */
export function recordError(db: DaveDatabase, ownerUserId: string, errorMessage: string): CircuitBreakerReport {
  const state = getOrCreateState(db, ownerUserId);
  const recentErrors = [...JSON.parse(state.recent_errors_json), errorMessage].slice(-TRIP_THRESHOLD);
  const consecutiveErrors = state.consecutive_errors + 1;
  const alreadyTripped = state.tripped === 1;
  const tripsNow = !alreadyTripped && consecutiveErrors >= TRIP_THRESHOLD;
  const tripped = alreadyTripped || tripsNow;
  const trippedAt = tripsNow ? Date.now() : state.tripped_at;

  db.update(TABLE, ownerUserId, state.id, {
    consecutive_errors: consecutiveErrors,
    tripped: tripped ? 1 : 0,
    recent_errors_json: JSON.stringify(recentErrors),
    tripped_at: trippedAt,
  });

  return { tripped, consecutiveErrors, recentErrors, trippedAt: trippedAt ?? undefined };
}

export function isTripped(db: DaveDatabase, ownerUserId: string): boolean {
  return toReport(getOrCreateState(db, ownerUserId)).tripped;
}

export function getReport(db: DaveDatabase, ownerUserId: string): CircuitBreakerReport {
  return toReport(getOrCreateState(db, ownerUserId));
}

/** A real, human-readable report -- this is what actually gets sent to the user when it trips, not a bare boolean. */
export function formatTripReport(report: CircuitBreakerReport): string {
  const lines = [
    `Circuit breaker tripped after ${report.consecutiveErrors} consecutive error(s) -- trading paused until this is reset.`,
    "Recent errors:",
    ...report.recentErrors.map((e, i) => `  ${i + 1}. ${e}`),
  ];
  return lines.join("\n");
}

/** Explicit reset only -- a trip is never silently cleared by a later success. */
export function resetCircuitBreaker(db: DaveDatabase, ownerUserId: string): void {
  const state = getOrCreateState(db, ownerUserId);
  db.update(TABLE, ownerUserId, state.id, { consecutive_errors: 0, tripped: 0, recent_errors_json: "[]", tripped_at: null });
}

export class CircuitBreakerTrippedError extends Error {
  constructor(report: CircuitBreakerReport) {
    super(formatTripReport(report));
    this.name = "CircuitBreakerTrippedError";
  }
}

/** Real gate: any trading action should call this first and refuse to proceed while tripped. */
export function assertNotTripped(db: DaveDatabase, ownerUserId: string): void {
  const report = getReport(db, ownerUserId);
  if (report.tripped) throw new CircuitBreakerTrippedError(report);
}
