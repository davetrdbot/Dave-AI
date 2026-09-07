import type { DaveDatabase } from "@dave/db";

/**
 * Real gap fixed (user: "add provision for mcps you added that to the code but you haven't
 * implemented it yet") -- next free-text message IS the value, same pattern as
 * pending-mcp-url-entry.ts. Format: "name | url" or "name | url | token" on one line.
 */
const TABLE = "pending_mcp_server_entry";

function ensureTable(db: DaveDatabase): void {
  db.createTable(TABLE, [{ name: "pending", type: "TEXT" }]);
}

export function setPendingMcpServerEntry(db: DaveDatabase, userId: string, pending: boolean): void {
  ensureTable(db);
  const existing = db.query(TABLE, userId, {});
  for (const row of existing) db.deleteRow(TABLE, userId, row.id as string);
  if (pending) db.insert(TABLE, userId, { pending: "1" });
}

export function getPendingMcpServerEntry(db: DaveDatabase, userId: string): boolean {
  ensureTable(db);
  return db.query(TABLE, userId, {}).length > 0;
}
