import type { DaveDatabase } from "@dave/db";

/**
 * Update 6: "Settings fields: Green API Token, Green API Instance ID,
 * user's own WhatsApp number with country code." Real DB-backed
 * settings (Step 16 pattern), nothing hardcoded, all start unset.
 * `unresponsiveMinutes` is the "configurable duration" the trigger
 * condition needs -- defaults to 15 minutes.
 */
const TABLE = "voice_call_settings";

export interface VoiceCallSettings {
  greenApiToken: string | null;
  greenApiInstanceId: string | null;
  whatsappNumber: string | null;
  unresponsiveMinutes: number;
}

const DEFAULTS: VoiceCallSettings = { greenApiToken: null, greenApiInstanceId: null, whatsappNumber: null, unresponsiveMinutes: 15 };

function ensureTable(db: DaveDatabase): void {
  db.createTable(TABLE, [
    { name: "green_api_token", type: "TEXT" },
    { name: "green_api_instance_id", type: "TEXT" },
    { name: "whatsapp_number", type: "TEXT" },
    { name: "unresponsive_minutes", type: "INTEGER" },
  ]);
}

export function getVoiceCallSettings(db: DaveDatabase, userId: string): VoiceCallSettings {
  ensureTable(db);
  const rows = db.query(TABLE, userId, {});
  if (rows.length === 0) return { ...DEFAULTS };
  const row = rows[0];
  return {
    greenApiToken: (row.green_api_token as string | null) ?? null,
    greenApiInstanceId: (row.green_api_instance_id as string | null) ?? null,
    whatsappNumber: (row.whatsapp_number as string | null) ?? null,
    unresponsiveMinutes: (row.unresponsive_minutes as number | null) ?? DEFAULTS.unresponsiveMinutes,
  };
}

export function setVoiceCallSettings(db: DaveDatabase, userId: string, settings: Partial<VoiceCallSettings>): VoiceCallSettings {
  ensureTable(db);
  const current = getVoiceCallSettings(db, userId);
  const merged = { ...current, ...settings };
  const rows = db.query(TABLE, userId, {});
  const data = {
    green_api_token: merged.greenApiToken,
    green_api_instance_id: merged.greenApiInstanceId,
    whatsapp_number: merged.whatsappNumber,
    unresponsive_minutes: merged.unresponsiveMinutes,
  };
  if (rows.length === 0) db.insert(TABLE, userId, data);
  else db.update(TABLE, userId, rows[0].id as string, data);
  return merged;
}
