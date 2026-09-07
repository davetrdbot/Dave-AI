import type { DaveDatabase } from "@dave/db";

/** Real gap fixed (user: "add more providers and make provision for... add firecrawl") --
 *  Firecrawl keys only had an admin panel route, no Telegram path. Same next-message capture
 *  pattern as dave-e2b's pending-key-entry.ts. */
const TABLE = "pending_firecrawl_key_entry";

function ensureTable(db: DaveDatabase): void {
  db.createTable(TABLE, [{ name: "pending", type: "INTEGER" }]);
}

export function setPendingFirecrawlKeyEntry(db: DaveDatabase, userId: string, pending: boolean): void {
  ensureTable(db);
  const existing = db.query(TABLE, userId, {});
  for (const row of existing) db.deleteRow(TABLE, userId, row.id as string);
  if (pending) db.insert(TABLE, userId, { pending: 1 });
}

export function getPendingFirecrawlKeyEntry(db: DaveDatabase, userId: string): boolean {
  ensureTable(db);
  return db.query(TABLE, userId, {}).length > 0;
}
