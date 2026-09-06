import type { DaveDatabase } from "@dave/db";
import type { TtsProviderName } from "./voice-settings.js";

/** Real gap fixed (user: "elevenlabs... should be settable in the telegram") -- the Voice
 * settings section let you toggle/pick a provider and voice, but never let you actually set
 * the provider's own API key -- that only existed via the admin panel. Same next-message
 * capture pattern as manual model/voice-id entry. */
const TABLE = "pending_tts_key_entry";

function ensureTable(db: DaveDatabase): void {
  db.createTable(TABLE, [{ name: "provider", type: "TEXT" }]);
}

export function setPendingTtsKeyEntry(db: DaveDatabase, userId: string, provider: TtsProviderName | null): void {
  ensureTable(db);
  const existing = db.query(TABLE, userId, {});
  for (const row of existing) db.deleteRow(TABLE, userId, row.id as string);
  if (provider) db.insert(TABLE, userId, { provider });
}

export function getPendingTtsKeyEntry(db: DaveDatabase, userId: string): TtsProviderName | null {
  ensureTable(db);
  const existing = db.query(TABLE, userId, {});
  return existing.length > 0 ? (existing[0].provider as TtsProviderName) : null;
}
