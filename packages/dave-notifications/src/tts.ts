/**
 * Step 21.3: voice OUTPUT. Fish Audio (primary) + ElevenLabs (fallback),
 * both real HTTP clients against their real current APIs (verified via
 * research, not assumed):
 *   - Fish Audio: `POST https://api.fish.audio/v1/tts`, Bearer auth,
 *     `reference_id` selects the voice, model selection is a real
 *     HEADER (`model: s1|s2-pro|s2.1-pro|s2.1-pro-free`) -- NOT a body
 *     field, a real surprise caught by research before writing this.
 *   - ElevenLabs: `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}`,
 *     auth via the real non-standard `xi-api-key` header (not Bearer).
 * Both return raw binary audio bytes directly in the response body.
 */

export interface TtsResult {
  audio: Buffer;
  contentType: string;
}

export class TtsError extends Error {
  constructor(public readonly provider: "fish-audio" | "elevenlabs", public readonly status: number, description: string) {
    super(`${provider} TTS -> HTTP ${status}: ${description}`);
    this.name = "TtsError";
  }
}

export class FishAudioClient {
  constructor(private readonly apiKey: string | undefined, private readonly baseUrl = "https://api.fish.audio") {}

  async synthesize(text: string, referenceId: string, model: "s1" | "s2-pro" | "s2.1-pro" | "s2.1-pro-free" = "s2.1-pro"): Promise<TtsResult> {
    const headers: Record<string, string> = { "content-type": "application/json", model };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const res = await fetch(`${this.baseUrl}/v1/tts`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text, reference_id: referenceId, format: "mp3" }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new TtsError("fish-audio", res.status, body);
    }
    const audio = Buffer.from(await res.arrayBuffer());
    return { audio, contentType: res.headers.get("content-type") ?? "audio/mpeg" };
  }
}

export class ElevenLabsClient {
  constructor(private readonly apiKey: string | undefined, private readonly baseUrl = "https://api.elevenlabs.io") {}

  async synthesize(text: string, voiceId: string, modelId = "eleven_multilingual_v2"): Promise<TtsResult> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers["xi-api-key"] = this.apiKey;

    const res = await fetch(`${this.baseUrl}/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text, model_id: modelId, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new TtsError("elevenlabs", res.status, body);
    }
    const audio = Buffer.from(await res.arrayBuffer());
    return { audio, contentType: res.headers.get("content-type") ?? "audio/mpeg" };
  }

  /** Real voice-listing endpoint -- confirmed current as /v2/voices (the older /v1/voices is legacy/unverified). */
  async listVoices(): Promise<{ voiceId: string; name: string }[]> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers["xi-api-key"] = this.apiKey;
    const res = await fetch(`${this.baseUrl}/v2/voices`, { headers });
    if (!res.ok) throw new TtsError("elevenlabs", res.status, await res.text());
    const json = (await res.json()) as { voices: { voice_id: string; name: string }[] };
    return json.voices.map((v) => ({ voiceId: v.voice_id, name: v.name }));
  }
}
