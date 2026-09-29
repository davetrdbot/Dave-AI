import type { DaveDatabase } from "@dave/db";
import type { TtsProviderName } from "./voice-settings.js";

/**
 * Real gap closed (Step 21 re-verification, final pre-deployment pass):
 * `voice_tts` required the MODEL to supply a raw `apiKey` argument on
 * EVERY single call -- unlike `add_provider_key` (a real, legitimate
 * one-time "the user just pasted their key in chat, store it" flow),
 * nothing ever persisted a Fish Audio/ElevenLabs key anywhere, so every
 * voice reply would have needed the user to re-paste their TTS key into
 * the chat, which never actually happens in practice -- the same class
 * of dead-end Step 20's `transcribeAudioBytesWithKeyFailover` fix
 * closed for Groq. This is that same real, persisted store for TTS,
 * kept as its own small table (not folded into `@dave/brain`'s
 * `ProviderName` catalog, which is exhaustively LLM-chat-shaped and
 * feeds the "AI Models" provider/fallback selection -- Fish Audio/
 * ElevenLabs are not chat-completion providers and don't belong there).
 */

const TABLE = "tts_provider_keys";

interface KeyRow {
  id: string;
  provider: TtsProviderName;
  api_key: string;
}

function ensureTable(db: DaveDatabase): void {
  db.createTable(TABLE, [
    { name: "provider", type: "TEXT" },
    { name: "api_key", type: "TEXT" },
  ]);
}

/** Real, persisted, one-time store -- the user pastes their key once (same real flow as add_provider_key), Dave never needs it supplied again. */
export function setTtsProviderKey(db: DaveDatabase, ownerUserId: string, provider: TtsProviderName, apiKey: string): void {
  ensureTable(db);
  const rows = db.query(TABLE, ownerUserId, { provider }) as unknown as KeyRow[];
  if (rows.length > 0) db.update(TABLE, ownerUserId, rows[0].id, { api_key: apiKey });
  else db.insert(TABLE, ownerUserId, { provider, api_key: apiKey });
}

export function getTtsProviderKey(db: DaveDatabase, ownerUserId: string, provider: TtsProviderName): string | undefined {
  ensureTable(db);
  const rows = db.query(TABLE, ownerUserId, { provider }) as unknown as KeyRow[];
  return rows[0]?.api_key;
}

export function hasTtsProviderKey(db: DaveDatabase, ownerUserId: string, provider: TtsProviderName): boolean {
  return getTtsProviderKey(db, ownerUserId, provider) !== undefined;
}

/** Forgets a provider's key (the app's "Remove key"). */
export function removeTtsProviderKey(db: DaveDatabase, ownerUserId: string, provider: TtsProviderName): boolean {
  ensureTable(db);
  const rows = db.query(TABLE, ownerUserId, { provider }) as unknown as KeyRow[];
  for (const r of rows) db.deleteRow(TABLE, ownerUserId, r.id);
  return rows.length > 0;
}

/**
 * The Gemini API key for talking to Dave live (Gemini Live -- the trader: "just add a place to put
 * the api key"). Kept in the same store as the voice keys; it isn't a text-to-speech provider, so
 * it has its own row name and its own helpers.
 */
const GEMINI_LIVE = "gemini-live" as unknown as TtsProviderName;

export const setGeminiLiveKey = (db: DaveDatabase, ownerUserId: string, apiKey: string) => setTtsProviderKey(db, ownerUserId, GEMINI_LIVE, apiKey);
export const getGeminiLiveKey = (db: DaveDatabase, ownerUserId: string) => getTtsProviderKey(db, ownerUserId, GEMINI_LIVE);
export const removeGeminiLiveKey = (db: DaveDatabase, ownerUserId: string) => removeTtsProviderKey(db, ownerUserId, GEMINI_LIVE);

/** Asks Google whether the key works (lists the models it can use). "unknown" when Google can't be reached. */
export async function checkGeminiKey(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<"ok" | "bad" | "unknown"> {
  try {
    const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(10_000) });
    if (res.ok) return "ok";
    return res.status === 400 || res.status === 401 || res.status === 403 ? "bad" : "unknown";
  } catch {
    return "unknown";
  }
}
