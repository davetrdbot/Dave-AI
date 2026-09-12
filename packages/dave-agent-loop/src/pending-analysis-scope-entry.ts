import type { DaveDatabase } from "@dave/db";

/** Same "next free-text message IS the value" pattern as pending MCP URL / active-pair entry --
 *  after tapping "Set custom timeframes" or "Set custom endpoints" in /settings' Analysis Scope
 *  screen, the user's next message is a comma-separated list of the ones to use. `kind`
 *  distinguishes which of the two the pending reply is for. */
export type AnalysisScopeEntryKind = "timeframes" | "endpoints";

const TABLE = "pending_analysis_scope_entry";

function ensureTable(db: DaveDatabase): void {
  db.createTable(TABLE, [{ name: "kind", type: "TEXT" }]);
}

export function setPendingAnalysisScopeEntry(db: DaveDatabase, userId: string, kind: AnalysisScopeEntryKind | null): void {
  ensureTable(db);
  const existing = db.query(TABLE, userId, {});
  for (const row of existing) db.deleteRow(TABLE, userId, row.id as string);
  if (kind) db.insert(TABLE, userId, { kind });
}

export function getPendingAnalysisScopeEntry(db: DaveDatabase, userId: string): AnalysisScopeEntryKind | null {
  ensureTable(db);
  const rows = db.query(TABLE, userId, {});
  return rows.length > 0 ? (rows[0].kind as AnalysisScopeEntryKind) : null;
}
