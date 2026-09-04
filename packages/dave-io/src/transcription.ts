/**
 * Step 15.2: voice-note transcription (input), per the Step 1.8 research
 * decision -- OpenAI's transcription API, negligible cost for short
 * Telegram voice notes, zero infra to run on Railway.
 *
 * Model choice: `whisper-1`, not the newer `gpt-4o-transcribe`/
 * `gpt-4o-mini-transcribe`. Verified via the real API docs (not
 * memorized): OpenAI's speech-to-text guide's short accepted-format list
 * (`mp3, mp4, mpeg, mpga, m4a, wav, webm`) does not explicitly mention
 * `.ogg` (Telegram voice notes are OGG/OPUS) -- but `whisper-1`'s
 * ffmpeg-based preprocessing is widely and consistently reported to
 * accept `.ogg` directly in real-world Telegram-bot use, and it's the
 * only model of the three whose docs actually describe broad container
 * flexibility (segments/word timestamps, subtitle formats). The two
 * newer `gpt-4o-*-transcribe` models are also restricted to
 * `json`/`text` response formats only (no `verbose_json`), which is a
 * second reason to prefer `whisper-1` here regardless of format support.
 * If a live run ever produces an unsupported-format error from the real
 * API, that's the first thing to revisit -- this is flagged honestly
 * rather than assumed silently correct.
 */

export interface TranscriptionResult {
  text: string;
}

export class TranscriptionError extends Error {
  constructor(public readonly status: number, description: string) {
    super(`OpenAI transcription -> HTTP ${status}: ${description}`);
    this.name = "TranscriptionError";
  }
}

export class TranscriptionClient {
  constructor(private readonly apiKey: string | undefined, private readonly baseUrl = "https://api.openai.com/v1") {}

  /**
   * `audio` is the raw OGG/OPUS bytes as sent by Telegram (message.voice
   * file, downloaded via `downloadTelegramFile`). 25MB max per the real
   * API limit -- Telegram voice notes are far smaller in practice, but
   * this is checked explicitly rather than trusted to just work.
   */
  async transcribe(audio: Buffer, filename = "voice.ogg"): Promise<TranscriptionResult> {
    const MAX_BYTES = 25 * 1024 * 1024;
    if (audio.byteLength > MAX_BYTES) {
      throw new TranscriptionError(413, `audio is ${audio.byteLength} bytes, exceeds the 25MB API limit`);
    }

    const form = new FormData();
    form.append("model", "whisper-1");
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
