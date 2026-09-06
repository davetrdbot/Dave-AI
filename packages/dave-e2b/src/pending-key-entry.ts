import type { DaveDatabase } from "@dave/db";

/** Real gap fixed (user: "e2b... should be settable in the telegram") -- E2B keys only had an
 * admin panel route, no Telegram path at all. Same next-message capture pattern used
 * throughout this build for API-key entry. */
const TABLE = "pending_e2b_key_entry";

function ensureTable(db: DaveDatabase): void {
  db.createTable(TABLE, [{ name: "pending", type: "INTEGER" }]);
}

export function setPendingE2BKeyEntry(db: DaveDatabase, userId: string, pending: boolean): void {
  ensureTable(db);
  const existing = db.query(TABLE, userId, {});
  for (const row of existing) db.deleteRow(TABLE, userId, row.id as string);
  if (pending) db.insert(TABLE, userId, { pending: 1 });
}

export function getPendingE2BKeyEntry(db: DaveDatabase, userId: string): boolean {
  ensureTable(db);
  return db.query(TABLE, userId, {}).length > 0;
}
