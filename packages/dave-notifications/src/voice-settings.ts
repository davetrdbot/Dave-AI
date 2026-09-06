import type { DaveDatabase } from "@dave/db";
import { FishAudioClient, ElevenLabsClient, TtsError, type TtsResult } from "./tts.js";
import { getTtsProviderKey } from "./tts-credentials.js";

/**
 * Step 21.3: real per-user voice settings -- enabled toggle (defaults
 * off, same "never silent by default" posture as Step 17/19's other
 * real toggles), which provider is currently active (switchable), and
 * a real configurable voice ID per provider (never hardcoded).
 */

export type TtsProviderName = "fish-audio" | "elevenlabs";

export interface VoiceSettings {
  enabled: boolean;
  activeProvider: TtsProviderName;
  fishVoiceId: string | null;
  elevenlabsVoiceId: string | null;
}

interface SettingsRow {
  id: string;
  enabled: number;
  active_provider: TtsProviderName;
  fish_voice_id: string | null;
  elevenlabs_voice_id: string | null;
}

const TABLE = "voice_settings";

function ensureTable(db: DaveDatabase): void {
  db.createTable(TABLE, [
    { name: "enabled", type: "INTEGER" },
    { name: "active_provider", type: "TEXT" },
    { name: "fish_voice_id", type: "TEXT" },
    { name: "elevenlabs_voice_id", type: "TEXT" },
  ]);
}

function getOrCreateRow(db: DaveDatabase, ownerUserId: string): SettingsRow {
  ensureTable(db);
  const rows = db.query(TABLE, ownerUserId, {}) as unknown as SettingsRow[];
  if (rows.length > 0) return rows[0];
  const id = db.insert(TABLE, ownerUserId, { enabled: 0, active_provider: "fish-audio" satisfies TtsProviderName, fish_voice_id: null, elevenlabs_voice_id: null });
  return db.getById(TABLE, ownerUserId, id) as unknown as SettingsRow;
}

function toSettings(row: SettingsRow): VoiceSettings {
  return { enabled: row.enabled === 1, activeProvider: row.active_provider, fishVoiceId: row.fish_voice_id, elevenlabsVoiceId: row.elevenlabs_voice_id };
}

export function getVoiceSettings(db: DaveDatabase, ownerUserId: string): VoiceSettings {
  return toSettings(getOrCreateRow(db, ownerUserId));
}

export function setVoiceEnabled(db: DaveDatabase, ownerUserId: string, enabled: boolean): void {
  const row = getOrCreateRow(db, ownerUserId);
  db.update(TABLE, ownerUserId, row.id, { enabled: enabled ? 1 : 0 });
}

export function setActiveProvider(db: DaveDatabase, ownerUserId: string, provider: TtsProviderName): void {
  const row = getOrCreateRow(db, ownerUserId);
  db.update(TABLE, ownerUserId, row.id, { active_provider: provider });
}

export function setVoiceId(db: DaveDatabase, ownerUserId: string, provider: TtsProviderName, voiceId: string): void {
  const row = getOrCreateRow(db, ownerUserId);
  db.update(TABLE, ownerUserId, row.id, provider === "fish-audio" ? { fish_voice_id: voiceId } : { elevenlabs_voice_id: voiceId });
}

/** Item 8 (/reset "config/settings back to defaults"): deletes the row so getVoiceSettings's own real defaults (off, fish-audio, no voice ids) apply again. Does NOT touch the stored TTS provider API keys -- those are credentials, not a "setting". */
export function resetVoiceSettingsForUser(db: DaveDatabase, ownerUserId: string): void {
  ensureTable(db);
  for (const row of db.query(TABLE, ownerUserId, {}) as unknown as SettingsRow[]) db.deleteRow(TABLE, ownerUserId, row.id);
}

export class VoiceDisabledError extends Error {
  constructor() {
    super("voice output is turned off for this user -- the whole feature is togglable off entirely, and it's off");
    this.name = "VoiceDisabledError";
  }
}

export class NoVoiceConfiguredError extends Error {
  constructor(provider: TtsProviderName) {
    super(`no voice ID configured for ${provider} yet`);
    this.name = "NoVoiceConfiguredError";
  }
}

export interface SynthesizeResult extends TtsResult {
  provider: TtsProviderName;
  usedFallback: boolean;
}

/**
 * The real fallback orchestration: tries the active provider first;
 * if that call genuinely fails, falls back to the other real provider
 * -- never silently returns nothing, never silently invents audio.
 */
export async function synthesizeSpeech(
  fish: FishAudioClient,
  eleven: ElevenLabsClient,
  db: DaveDatabase,
  ownerUserId: string,
  text: string
): Promise<SynthesizeResult> {
  const settings = getVoiceSettings(db, ownerUserId);
  if (!settings.enabled) throw new VoiceDisabledError();

  const order: TtsProviderName[] = settings.activeProvider === "fish-audio" ? ["fish-audio", "elevenlabs"] : ["elevenlabs", "fish-audio"];

  let lastError: unknown;
  for (const [i, provider] of order.entries()) {
    const voiceId = provider === "fish-audio" ? settings.fishVoiceId : settings.elevenlabsVoiceId;
    if (!voiceId) {
      lastError = new NoVoiceConfiguredError(provider);
      continue;
    }
    try {
      const result = provider === "fish-audio" ? await fish.synthesize(text, voiceId) : await eleven.synthesize(text, voiceId);
      return { ...result, provider, usedFallback: i > 0 };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new TtsError(settings.activeProvider, 0, "both providers failed");
}

export class NoTtsKeyError extends Error {
  constructor() {
    super('no stored TTS provider key for either fish-audio or elevenlabs -- paste one in chat and store it with set_tts_provider_key first');
    this.name = "NoTtsKeyError";
  }
}

/**
 * Real gap closed: the only way to call `synthesizeSpeech` before this
 * was to already have real `FishAudioClient`/`ElevenLabsClient`
 * instances built with a real key IN HAND -- which meant every single
 * caller had to supply a raw key itself. This builds those clients from
 * the real, PERSISTED per-user keys (`set_tts_provider_key`, stored
 * once), the same "stored once, used forever" shape every other
 * credentialed call in this build already follows.
 */
export async function synthesizeSpeechWithStoredKeys(db: DaveDatabase, ownerUserId: string, text: string): Promise<SynthesizeResult> {
  const fishKey = getTtsProviderKey(db, ownerUserId, "fish-audio");
  const elevenKey = getTtsProviderKey(db, ownerUserId, "elevenlabs");
  if (!fishKey && !elevenKey) throw new NoTtsKeyError();
  return synthesizeSpeech(new FishAudioClient(fishKey), new ElevenLabsClient(elevenKey), db, ownerUserId, text);
}
