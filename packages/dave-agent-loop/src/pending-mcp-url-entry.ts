import type { DaveDatabase } from "@dave/db";

/**
 * Real gap fixed (user: "add the mcp for trading so incase they don't want to use the ea") --
 * same "next free-text message IS the value" pattern as pending model/voice/key entry: after
 * tapping "MCP for trading" in /ea, the user's next message is the real MCP server URL.
 */
const TABLE = "pending_mcp_url_entry";

function ensureTable(db: DaveDatabase): void {
  db.createTable(TABLE, [{ name: "pending", type: "TEXT" }]);
}

export function setPendingMcpUrlEntry(db: DaveDatabase, userId: string, pending: boolean): void {
  ensureTable(db);
  const existing = db.query(TABLE, userId, {});
  for (const row of existing) db.deleteRow(TABLE, userId, row.id as string);
  if (pending) db.insert(TABLE, userId, { pending: "1" });
}

export function getPendingMcpUrlEntry(db: DaveDatabase, userId: string): boolean {
  ensureTable(db);
  return db.query(TABLE, userId, {}).length > 0;
}
