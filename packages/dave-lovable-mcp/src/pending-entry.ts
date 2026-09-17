import type { DaveDatabase } from "@dave/db";

/**
 * Real gap fixed (settings audit item 3): get_lovable_mcp_settings/set_lovable_mcp_settings
 * (settings-tools.ts) were only reachable by the model deciding to call them -- there was no
 * user-facing /settings surface, unlike every other credential (E2B, Firecrawl, TTS, MCP
 * servers) which all got a real next-message capture path in command-router.ts. Same pattern
 * as dave-notifications' pending-tts-key-entry.ts: one pending row per user, storing WHICH
 * field ("url" or "token") the next free-text message should fill.
 */
export type LovableMcpPendingField = "url" | "token";

const TABLE = "pending_lovable_mcp_entry";

function ensureTable(db: DaveDatabase): void {
  db.createTable(TABLE, [{ name: "field", type: "TEXT" }]);
}

export function setPendingLovableMcpEntry(db: DaveDatabase, userId: string, field: LovableMcpPendingField | null): void {
  ensureTable(db);
  const existing = db.query(TABLE, userId, {});
  for (const row of existing) db.deleteRow(TABLE, userId, row.id as string);
  if (field) db.insert(TABLE, userId, { field });
}

export function getPendingLovableMcpEntry(db: DaveDatabase, userId: string): LovableMcpPendingField | null {
  ensureTable(db);
  const existing = db.query(TABLE, userId, {});
  return existing.length > 0 ? (existing[0].field as LovableMcpPendingField) : null;
}
