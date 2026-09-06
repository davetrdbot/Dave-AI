import type { DaveDatabase } from "@dave/db";
import type { TtsProviderName } from "./voice-settings.js";

/**
 * Fish Audio has no listable-voices endpoint (its voice IDs are the
 * user's own uploaded reference_ids) -- unlike ElevenLabs (real
 * /v2/voices, button-selectable), Fish Audio's voice ID has to be
 * captured from the user's own next free-text message. Same persisted
 * "next message IS the value" pattern as manual model entry.
 */
const TABLE = "pending_voice_id_entry";

function ensureTable(db: DaveDatabase): void {
  db.createTable(TABLE, [{ name: "provider", type: "TEXT" }]);
}

export function setPendingVoiceIdEntry(db: DaveDatabase, userId: string, provider: TtsProviderName | null): void {
  ensureTable(db);
  const existing = db.query(TABLE, userId, {});
  for (const row of existing) db.deleteRow(TABLE, userId, row.id as string);
  if (provider) db.insert(TABLE, userId, { provider });
}

export function getPendingVoiceIdEntry(db: DaveDatabase, userId: string): TtsProviderName | null {
  ensureTable(db);
  const existing = db.query(TABLE, userId, {});
  return existing.length > 0 ? (existing[0].provider as TtsProviderName) : null;
}
