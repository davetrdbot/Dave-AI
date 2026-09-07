import type { DaveDatabase } from "@dave/db";
import type { ProviderName } from "./providers.js";

/**
 * Real gap fixed (user: "I can set up to 20 keys in the telegram and paste the settable
 * credentials in telegram") -- /providers could drill into a provider and activate an
 * EXISTING stored key, but there was no way to actually ADD a key from Telegram itself, only
 * through the admin panel. Same persisted "next message IS the value" pattern as manual model
 * entry / manual voice-id entry: the user's next message is treated as one or more API keys
 * (one per line, up to 20 -- addProviderKeysBulk already enforces the cap and reports
 * per-line success/failure), so a single pasted key and a bulk paste are the same real flow.
 */
const TABLE = "pending_key_entry";

function ensureTable(db: DaveDatabase): void {
  db.createTable(TABLE, [{ name: "provider", type: "TEXT" }]);
}

export function setPendingKeyEntry(db: DaveDatabase, userId: string, provider: ProviderName | null): void {
  ensureTable(db);
  const existing = db.query(TABLE, userId, {});
  for (const row of existing) db.deleteRow(TABLE, userId, row.id as string);
  if (provider) db.insert(TABLE, userId, { provider });
}

export function getPendingKeyEntry(db: DaveDatabase, userId: string): ProviderName | null {
  ensureTable(db);
  const existing = db.query(TABLE, userId, {});
  return existing.length > 0 ? (existing[0].provider as ProviderName) : null;
}
