import { NextResponse } from "next/server";
import { DaveDatabase } from "@dave/db";
import {
  getVoiceSettings,
  setVoiceEnabled,
  setActiveProvider,
  setVoiceId,
  getTtsProviderKey,
  setTtsProviderKey,
  removeTtsProviderKey,
  ElevenLabsClient,
  FishAudioClient,
  listFishVoices,
  synthesizeSpeech,
  type TtsProviderName,
} from "@dave/notifications";
import { dbPathFor } from "../../../../server/db-path";
import { maskSecret } from "../../../../server/mask-secret";
import { withDevice } from "../../../../server/require-device";
import { speakable } from "../../../../server/speakable";

/**
 * Dave's voice, from the phone: ElevenLabs and Fish Audio -- keys, which one leads (the other is
 * the fallback), the voice for each, a preview, and "say this" for reading a reply aloud in the
 * app. The same store the Telegram voice replies already use, so one setup serves both.
 *
 *   GET                                   status (keys come back masked)
 *   POST {action:"key", provider, apiKey} / {action:"remove-key", provider}
 *   POST {action:"provider", provider} / {action:"voice", provider, voiceId} / {action:"enabled", enabled}
 *   POST {action:"voices", provider, query?}   the voices that key can use
 *   POST {action:"preview", provider, voiceId, text?}   -> {audio: base64, contentType}
 *   POST {action:"speak", text}                 -> the active voice (falls back to the other)
 */
export const dynamic = "force-dynamic";

const PROVIDERS: { id: TtsProviderName; name: string; about: string; link: string }[] = [
  { id: "elevenlabs", name: "ElevenLabs", about: "Most natural voices; clone your own.", link: "https://elevenlabs.io/app/settings/api-keys" },
  { id: "fish-audio", name: "Fish Audio", about: "Cheaper, huge public voice library, good cloning.", link: "https://fish.audio/app/api-keys" },
];

function withDb<T>(userId: string, fn: (db: DaveDatabase) => T): T {
  const db = new DaveDatabase(dbPathFor(userId));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function view(db: DaveDatabase, userId: string) {
  const s = getVoiceSettings(db, userId);
  return {
    enabled: s.enabled,
    activeProvider: s.activeProvider,
    providers: PROVIDERS.map((p) => ({
      ...p,
      key: maskSecret(getTtsProviderKey(db, userId, p.id)) ?? null,
      voiceId: p.id === "elevenlabs" ? s.elevenlabsVoiceId : s.fishVoiceId,
    })),
  };
}

const isProvider = (v: unknown): v is TtsProviderName => v === "elevenlabs" || v === "fish-audio";

export const GET = withDevice(async ({ userId }) => NextResponse.json(withDb(userId, (db) => view(db, userId))));

export const POST = withDevice(async ({ userId, req }) => {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const db = new DaveDatabase(dbPathFor(userId));
  try {
    const provider = body.provider;
    switch (body.action) {
      case "key": {
        const key = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
        if (!isProvider(provider) || key.length < 10) return NextResponse.json({ error: "Paste the whole API key." }, { status: 400 });
        setTtsProviderKey(db, userId, provider, key);
        break;
      }
      case "remove-key":
        if (!isProvider(provider)) return NextResponse.json({ error: "Which provider?" }, { status: 400 });
        removeTtsProviderKey(db, userId, provider);
        break;
      case "provider":
        if (!isProvider(provider)) return NextResponse.json({ error: "Which provider?" }, { status: 400 });
        setActiveProvider(db, userId, provider);
        break;
      case "voice": {
        const voiceId = typeof body.voiceId === "string" ? body.voiceId.trim() : "";
        if (!isProvider(provider) || !voiceId) return NextResponse.json({ error: "Pick a voice." }, { status: 400 });
        setVoiceId(db, userId, provider, voiceId);
        break;
      }
      case "enabled":
        setVoiceEnabled(db, userId, body.enabled === true);
        break;
      case "voices": {
        if (!isProvider(provider)) return NextResponse.json({ error: "Which provider?" }, { status: 400 });
        const key = getTtsProviderKey(db, userId, provider);
        if (!key) return NextResponse.json({ error: `Add a ${provider === "elevenlabs" ? "ElevenLabs" : "Fish Audio"} key first.` }, { status: 409 });
        const query = typeof body.query === "string" ? body.query : "";
        const voices =
          provider === "elevenlabs"
            ? (await new ElevenLabsClient(key).listVoices()).filter((v) => !query || v.name.toLowerCase().includes(query.toLowerCase())).map((v) => ({ ...v, mine: false }))
            : await listFishVoices(key, query);
        return NextResponse.json({ voices: voices.slice(0, 80) });
      }
      case "preview": {
        const voiceId = typeof body.voiceId === "string" ? body.voiceId : "";
        if (!isProvider(provider) || !voiceId) return NextResponse.json({ error: "Pick a voice." }, { status: 400 });
        const key = getTtsProviderKey(db, userId, provider);
        if (!key) return NextResponse.json({ error: "Add the key first." }, { status: 409 });
        const text = speakable(typeof body.text === "string" && body.text.trim() ? body.text : "Hey, it's Dave. Gold's up one R -- want me to move the stop to breakeven?");
        const r = provider === "elevenlabs" ? await new ElevenLabsClient(key).synthesize(text, voiceId) : await new FishAudioClient(key).synthesize(text, voiceId);
        return NextResponse.json({ audio: r.audio.toString("base64"), contentType: r.contentType });
      }
      case "speak": {
        const text = speakable(typeof body.text === "string" ? body.text : "");
        if (!text) return NextResponse.json({ error: "Nothing to say." }, { status: 400 });
        const fishKey = getTtsProviderKey(db, userId, "fish-audio");
        const elevenKey = getTtsProviderKey(db, userId, "elevenlabs");
        if (!fishKey && !elevenKey) return NextResponse.json({ error: "Add an ElevenLabs or Fish Audio key in Settings > Dave's voice." }, { status: 409 });
        if (!getVoiceSettings(db, userId).enabled) return NextResponse.json({ error: "Dave's voice is switched off -- turn it on in Settings > Dave's voice." }, { status: 409 });
        const r = await synthesizeSpeech(new FishAudioClient(fishKey), new ElevenLabsClient(elevenKey), db, userId, text);
        return NextResponse.json({ audio: r.audio.toString("base64"), contentType: r.contentType, provider: r.provider, usedFallback: r.usedFallback });
      }
      default:
        return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }
    return NextResponse.json({ ok: true, ...view(db, userId) });
  } catch (err) {
    // Provider errors carry the provider's own reason (bad key, quota, unknown voice) -- never the key.
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg.replace(/(sk|key)[_-]?[A-Za-z0-9]{16,}/g, "[key]").slice(0, 300) }, { status: 502 });
  } finally {
    db.close();
  }
});
