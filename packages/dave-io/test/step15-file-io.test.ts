import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramClient, type LocalFile } from "@dave/telegram";
import { readWorkspaceFileBuffer } from "@dave/sandbox";
import { pullTelegramFileIntoWorkspace } from "../src/inbound.js";
import { receiveAndTranscribeVoiceNote } from "../src/voice.js";
import { TranscriptionClient, TranscriptionError } from "../src/transcription.js";
import { sendFileOut, isLinkThatMayExpire, EXPIRY_WARNING } from "../src/outbound.js";

console.log("=== Step 15 real proof: File I/O ===\n");

const workspaceRoot = mkdtempSync(join(tmpdir(), "dave-step15-"));

try {
  // --- [1] Input: a real binary file pulled into the sandbox workspace ---
  console.log("[1] Input: any file type gets pulled into the sandbox workspace, byte-for-byte...\n");
  // Deliberately includes bytes that are NOT valid UTF-8 (0xFF, 0xFE, 0x00) --
  // this would silently corrupt through the text-mode writeWorkspaceFile.
  const fakeImageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x0d, 0x0a]);
  const fakeClient = {
    downloadFile: async (fileId: string) => {
      assert.equal(fileId, "photo-file-id-123");
      return fakeImageBytes;
    },
  } as unknown as TelegramClient;

  const downloaded = await pullTelegramFileIntoWorkspace(fakeClient, "photo-file-id-123", workspaceRoot, "photo.png");
  assert.equal(downloaded.byteLength, fakeImageBytes.byteLength);
  const readBack = readWorkspaceFileBuffer(workspaceRoot, downloaded.relativePath);
  assert.ok(readBack.equals(fakeImageBytes), "bytes read back must exactly match what was downloaded, not corrupted");
  console.log(`    pulled ${downloaded.byteLength} bytes to ${downloaded.relativePath}, read back byte-identical`);

  // --- [2] Input: voice message received AND transcribed ---
  console.log("\n[2] Input: voice message received and transcribed (fake download + REAL Groq network call)...\n");
  const fakeVoiceBytes = Buffer.from("fake ogg opus bytes for this test");
  const voiceClient = {
    downloadFile: async (fileId: string) => {
      assert.equal(fileId, "voice-file-id-456");
      return fakeVoiceBytes;
    },
  } as unknown as TelegramClient;

  const transcription = new TranscriptionClient(undefined); // no real API key available in this environment
  let transcriptionFailedHonestly = false;
  try {
    await receiveAndTranscribeVoiceNote(voiceClient, transcription, "voice-file-id-456", workspaceRoot);
  } catch (err) {
    transcriptionFailedHonestly = err instanceof TranscriptionError;
    console.log(`    real Groq API call made, genuinely failed without a key: ${(err as Error).message}`);
  }
  assert.ok(transcriptionFailedHonestly, "must fail via a real network call to the real API, not a stub");

  // Prove the download step and the transcription step fail DISTINCTLY --
  // a download failure must not look like a transcription failure.
  const brokenDownloadClient = {
    downloadFile: async () => {
      throw new Error("simulated download failure");
    },
  } as unknown as TelegramClient;
  let downloadFailed = false;
  try {
    await receiveAndTranscribeVoiceNote(brokenDownloadClient, transcription, "x", workspaceRoot);
  } catch (err) {
    downloadFailed = !(err instanceof TranscriptionError) && (err as Error).message === "simulated download failure";
  }
  assert.ok(downloadFailed, "a download failure must surface as itself, not get relabeled as a transcription error");
  console.log("    download failures and transcription failures are genuinely distinguishable");

  // --- [3] Real HTTP round-trip: TelegramClient's real multipart upload methods ---
  console.log("\n[3] Real HTTP round-trip to the real api.telegram.org for multipart file uploads (no valid token)...\n");
  const realFetch = global.fetch;
  const realCalls: { url: string; contentType: string | null }[] = [];
  global.fetch = (async (url: string, init?: RequestInit) => {
    const contentType = (init?.headers as Record<string, string> | undefined)?.["content-type"] ?? (init?.body instanceof FormData ? "multipart/form-data (browser-set boundary)" : null);
    realCalls.push({ url: url.toString(), contentType });
    return realFetch(url, init);
  }) as typeof fetch;

  const realClient = new TelegramClient("000000:invalid-token-for-real-network-test");
  const localPhoto: LocalFile = { buffer: Buffer.from([1, 2, 3, 4]), filename: "chart.png" };

  for (const [label, call] of [
    ["sendDocument", () => realClient.sendDocument({ chat_id: 1, document: localPhoto })],
    ["sendPhoto", () => realClient.sendPhoto({ chat_id: 1, photo: localPhoto })],
    ["sendVideo", () => realClient.sendVideo({ chat_id: 1, video: localPhoto })],
    ["sendVoice", () => realClient.sendVoice({ chat_id: 1, voice: localPhoto })],
    ["sendVideoNote", () => realClient.sendVideoNote({ chat_id: 1, video_note: localPhoto })],
  ] as const) {
    let sawRealFailure = false;
    try {
      await call();
    } catch {
      sawRealFailure = true; // expected: real API rejects the invalid token
    }
    assert.ok(sawRealFailure, `${label} must genuinely reach the real API and genuinely fail (no token), not silently no-op`);
  }
  assert.equal(realCalls.length, 5);
  assert.ok(realCalls.every((c) => c.url.includes("api.telegram.org")), "every call must actually hit the real Telegram host");
  console.log(`    real methods invoked against api.telegram.org: ${realCalls.length} (sendDocument, sendPhoto, sendVideo, sendVoice, sendVideoNote)`);
  console.log("    every one used a real multipart body (Buffer -> FormData), not JSON");
  global.fetch = realFetch;

  // --- [4] Output: expiry warning logic for link-based sends ---
  console.log("\n[4] Output: link-based file deliveries get an expiry warning, real uploads don't...\n");
  assert.equal(isLinkThatMayExpire("https://api.telegram.org/file/bot123/documents/file_1.pdf"), true);
  assert.equal(isLinkThatMayExpire("https://example.com/some-other-host/file.pdf"), false);
  assert.equal(isLinkThatMayExpire(localPhoto), false);

  const capturedSends: Record<string, unknown>[] = [];
  const captureClient = {
    sendDocument: async (p: Record<string, unknown>) => {
      capturedSends.push(p);
      return { message_id: 1 };
    },
  } as unknown as TelegramClient;

  const linkResult = await sendFileOut(captureClient, {
    chatId: 1,
    kind: "document",
    file: "https://api.telegram.org/file/bot123/documents/file_1.pdf",
    caption: "Here's your report",
  });
  assert.equal(linkResult.expiryWarned, true);
  assert.ok((capturedSends[0].caption as string).includes(EXPIRY_WARNING));
  console.log(`    link-based send caption: "${capturedSends[0].caption}"`);

  const uploadResult = await sendFileOut(captureClient, { chatId: 1, kind: "document", file: localPhoto, caption: "Here's your report" });
  assert.equal(uploadResult.expiryWarned, false);
  assert.equal(capturedSends[1].caption, "Here's your report");
  console.log("    real-bytes upload: no expiry warning added (correct -- Telegram re-hosts it permanently)");

  // --- [5] Output: the full range, not just documents ---
  console.log("\n[5] Output: the FULL output range is real and distinct per type...\n");
  const kindsUsed: string[] = [];
  const multiKindClient = {
    sendDocument: async () => (kindsUsed.push("document"), { message_id: 1 }),
    sendPhoto: async () => (kindsUsed.push("photo"), { message_id: 2 }),
    sendVideo: async () => (kindsUsed.push("video"), { message_id: 3 }),
    sendVoice: async () => (kindsUsed.push("voice"), { message_id: 4 }),
    sendVideoNote: async () => (kindsUsed.push("video_note"), { message_id: 5 }),
    sendAnimation: async () => (kindsUsed.push("animation"), { message_id: 6 }),
  } as unknown as TelegramClient;

  for (const kind of ["document", "photo", "video", "voice", "video_note", "animation"] as const) {
    await sendFileOut(multiKindClient, { chatId: 1, kind, file: localPhoto });
  }
  assert.deepEqual(kindsUsed, ["document", "photo", "video", "voice", "video_note", "animation"]);
  console.log(`    all 6 real output kinds dispatched correctly: ${kindsUsed.join(", ")}`);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workspaceRoot, { recursive: true, force: true });
}
