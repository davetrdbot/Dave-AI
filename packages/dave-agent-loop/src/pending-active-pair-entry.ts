import type { DaveDatabase } from "@dave/db";

/** Same "next free-text message IS the value" pattern as pending MCP URL entry -- the user's next
 *  message after tapping "Focus one pair" is the real symbol to narrow scanning down to. */
const TABLE = "pending_active_pair_entry";

function ensureTable(db: DaveDatabase): void {
  db.createTable(TABLE, [{ name: "pending", type: "TEXT" }]);
}

export function setPendingActivePairEntry(db: DaveDatabase, userId: string, pending: boolean): void {
  ensureTable(db);
  const existing = db.query(TABLE, userId, {});
  for (const row of existing) db.deleteRow(TABLE, userId, row.id as string);
  if (pending) db.insert(TABLE, userId, { pending: "1" });
}

export function getPendingActivePairEntry(db: DaveDatabase, userId: string): boolean {
  ensureTable(db);
  return db.query(TABLE, userId, {}).length > 0;
}
