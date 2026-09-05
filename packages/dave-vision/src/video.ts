import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runCode } from "@dave/sandbox";
import { TranscriptionClient, type TimestampedTranscript } from "@dave/io";
import type { DaveDatabase } from "@dave/db";
import { listProviderKeys } from "@dave/brain";

const GROQ_PROVIDER = "groq";

/**
 * Step 20.2: scene-aware keyframe extraction + timestamped transcript,
 * both real, both inside the sandbox (Step 6's real confinement/
 * fail-closed `runCode`, not a bare child_process call bypassing it).
 *
 * Keyframe extraction: real ffmpeg, the `select` filter's `scene`
 * variable (0-1, "how different is this frame from the last one" --
 * FFmpeg's own docs recommend a 0.3-0.5 threshold for real scene
 * changes), combined with `showinfo` to print each selected frame's
 * real `pts_time` to stderr -- confirmed exact syntax and output format
 * via research against ffmpeg's own docs, including the backslash-
 * escaped comma inside the quoted scene expression (`gt(scene\,X)`),
 * which ffmpeg's filtergraph parser genuinely requires even when not
 * going through a shell.
 *
 * Timestamped transcript: Groq's real `verbose_json` response format
 * (Step 15/20's transcription client) -- `.mp4` is explicitly on Groq's
 * accepted-format list, so the whole video file is handed to it
 * directly; no separate audio-extraction step is needed.
 */

export interface Keyframe {
  relativePath: string;
  timestampSeconds: number;
}

const PTS_TIME_PATTERN = /pts_time:([\d.]+)/g;

export class FfmpegError extends Error {
  constructor(exitCode: number | null, stderr: string) {
    super(`ffmpeg failed (exit ${exitCode}): ${stderr.slice(-1500)}`);
    this.name = "FfmpegError";
  }
}

export async function extractKeyframes(
  videoRelativePath: string,
  workspaceRoot: string,
  sceneThreshold = 0.4,
  outputDir = "keyframes"
): Promise<Keyframe[]> {
  const outDirAbs = join(workspaceRoot, outputDir);
  if (!existsSync(outDirAbs)) mkdirSync(outDirAbs, { recursive: true });

  const filter = `select='gt(scene\\,${sceneThreshold})',showinfo`;
  const outputPattern = join(outputDir, "frame_%04d.png");

  const result = await runCode("ffmpeg", ["-y", "-i", videoRelativePath, "-filter:v", filter, "-vsync", "vfr", outputPattern], workspaceRoot, 60_000);
  if (result.exitCode !== 0) throw new FfmpegError(result.exitCode, result.stderr);

  const timestamps = [...result.stderr.matchAll(PTS_TIME_PATTERN)].map((m) => parseFloat(m[1]));
  const frameFiles = readdirSync(outDirAbs)
    .filter((f) => f.startsWith("frame_"))
    .sort();

  return frameFiles.map((file, i) => ({
    relativePath: join(outputDir, file),
    timestampSeconds: timestamps[i] ?? 0,
  }));
}

export async function transcribeVideoWithTimestamps(
  transcription: TranscriptionClient,
  videoRelativePath: string,
  workspaceRoot: string
): Promise<TimestampedTranscript> {
  const bytes = readFileSync(join(workspaceRoot, videoRelativePath));
  return transcription.transcribeWithTimestamps(bytes, videoRelativePath.split("/").pop() ?? "video.mp4");
}

export class NoGroqKeyError extends Error {
  constructor() {
    super('no stored provider key for "groq" -- add one on the Credentials tab (or via add_provider_key) before Dave can transcribe voice notes');
    this.name = "NoGroqKeyError";
  }
}

/**
 * Real gap closed (final pre-deployment pass): the agent-tool version of
 * transcription required the CALLER (the model) to supply a raw apiKey
 * argument -- but a model has no way to know a real secret, so that
 * tool was never actually reachable end to end. This mirrors
 * `generateWithKeyFailover`'s real pattern (dave-brain/provider-keys.ts):
 * pull the user's own stored "groq" provider key(s) from the DB, try
 * them in health-first order, exactly like every other credentialed
 * call in this build already does -- no plaintext key ever has to pass
 * through the model.
 */
export async function transcribeAudioBytesWithKeyFailover(
  db: DaveDatabase,
  userId: string,
  audio: Buffer,
  filename: string
): Promise<TimestampedTranscript> {
  const keys = listProviderKeys(db, userId, GROQ_PROVIDER);
  if (keys.length === 0) throw new NoGroqKeyError();
  const ordered = [...keys.filter((k) => k.healthy), ...keys.filter((k) => !k.healthy)];
  let lastErr: unknown;
  for (const key of ordered) {
    const client = new TranscriptionClient(key.config.apiKey);
    try {
      return await client.transcribeWithTimestamps(audio, filename);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("all stored Groq keys failed transcription");
}
