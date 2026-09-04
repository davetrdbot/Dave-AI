/**
 * Step 15.2: voice-note transcription (input). Provider is Groq, not
 * OpenAI -- corrected per explicit instruction. Verified against the
 * real Groq API docs (console.groq.com/docs): Groq exposes an
 * OpenAI-compatible route at `/openai/v1/audio/transcriptions` under
 * its own host, so the request/response shape below mirrors OpenAI's
 * but targets `api.groq.com` with a Groq API key and Groq's own model
 * names.
 *
 * Model: `whisper-large-v3-turbo` -- Groq's fastest/cheapest current
 * transcription model ($0.04/hour vs $0.111/hour for the full
 * `whisper-large-v3`), the right tradeoff for short Telegram voice
 * notes where turnaround speed matters more than the last percent of
 * accuracy. `.ogg` (Telegram voice notes' real format) is explicitly
 * on Groq's documented accepted-format list -- confirmed, unlike the
 * ambiguity found in OpenAI's own docs for the same question.
 */

export interface TranscriptionResult {
  text: string;
}

export class TranscriptionError extends Error {
  constructor(public readonly status: number, description: string) {
    super(`Groq transcription -> HTTP ${status}: ${description}`);
    this.name = "TranscriptionError";
  }
}

export class TranscriptionClient {
  constructor(private readonly apiKey: string | undefined, private readonly baseUrl = "https://api.groq.com/openai/v1") {}

  /**
   * `audio` is the raw OGG/OPUS bytes as sent by Telegram (message.voice
   * file, downloaded via `downloadTelegramFile`). Groq's real documented
   * limit is 25MB on the free tier (100MB on the dev tier) -- Telegram
   * voice notes are far smaller in practice, but this is checked
   * explicitly rather than trusted to just work.
   */
  async transcribe(audio: Buffer, filename = "voice.ogg"): Promise<TranscriptionResult> {
    const MAX_BYTES = 25 * 1024 * 1024;
    if (audio.byteLength > MAX_BYTES) {
      throw new TranscriptionError(413, `audio is ${audio.byteLength} bytes, exceeds the 25MB free-tier API limit`);
    }

    const form = new FormData();
    form.append("model", "whisper-large-v3-turbo");
    form.append("response_format", "json");
    form.append("file", new Blob([new Uint8Array(audio)]), filename);

    const headers: Record<string, string> = {};
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const res = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers,
      body: form,
    });
    const json = await res.json();
    if (!res.ok) {
      throw new TranscriptionError(res.status, json?.error?.message ?? JSON.stringify(json));
    }
    return { text: json.text as string };
  }
}
