import { readWorkspaceFileBuffer } from "@dave/sandbox";
import type { TelegramClient } from "@dave/telegram";
import { pullTelegramFileIntoWorkspace } from "./inbound.js";
import { TranscriptionClient, type TranscriptionResult } from "./transcription.js";

/**
 * Step 15.2: voice messages the user sends are received AND transcribed
 * -- pulls the real .ogg/OPUS bytes in via the same path as any other
 * inbound file (15.1), then runs them through the real OpenAI
 * transcription API. Two real, separately-failing steps, not one
 * opaque call -- a download failure and a transcription failure are
 * distinguishable.
 */
export async function receiveAndTranscribeVoiceNote(
  client: TelegramClient,
  transcription: TranscriptionClient,
  fileId: string,
  workspaceRoot: string
): Promise<{ transcript: TranscriptionResult; relativePath: string }> {
  const downloaded = await pullTelegramFileIntoWorkspace(client, fileId, workspaceRoot, `voice-${Date.now()}.ogg`);
  const bytes = readWorkspaceFileBuffer(workspaceRoot, downloaded.relativePath);
  const transcript = await transcription.transcribe(bytes, "voice.ogg");
  return { transcript, relativePath: downloaded.relativePath };
}
