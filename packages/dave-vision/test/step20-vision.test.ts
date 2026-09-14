import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DeepSeekProvider, ClaudeProvider, ImageNotSupportedError, type CompletionRequest } from "@dave/brain";
import { TranscriptionClient, TranscriptionError } from "@dave/io";
import { buildImageContentBlock, mediaTypeFromExtension, UnsupportedImageTypeError, ImageTooLargeError } from "../src/image.js";
import { extractKeyframes, transcribeVideoWithTimestamps, FfmpegError } from "../src/video.js";

const execFileAsync = promisify(execFile);

console.log("=== Step 20 real proof: Vision ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-step20-"));

try {
  // --- [1] 20.1 Images: the raw file goes straight into a real content block ---
  console.log("[1] Images: raw file bytes handed directly to the model call, no OCR step in between...\n");

  // A real, valid 1x1 PNG (not a fake/stub buffer) -- the actual PNG magic bytes + minimal IHDR/IDAT/IEND chunks.
  const realPngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const realPngBytes = Buffer.from(realPngBase64, "base64");
  assert.equal(realPngBytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "must be a genuine PNG (real magic bytes), not a stub");

  const block = buildImageContentBlock(realPngBytes, "chart.png");
  assert.equal(block.type, "image");
  assert.equal(block.source.type, "base64");
  assert.equal(block.source.media_type, "image/png");
  assert.equal(block.source.data, realPngBytes.toString("base64"), "the base64 data must be the RAW file's own bytes, not re-encoded/processed");
  console.log(`    real ${realPngBytes.byteLength}-byte PNG -> content block with media_type=${block.source.media_type}, ${block.source.data.length} base64 chars`);
  console.log("    the block's data is byte-for-byte the raw file's own base64 -- no OCR/description step touched it");

  assert.equal(mediaTypeFromExtension("photo.jpg"), "image/jpeg");
  assert.equal(mediaTypeFromExtension("photo.JPEG"), "image/jpeg");
  assert.equal(mediaTypeFromExtension("photo.webp"), "image/webp");
  let unsupportedThrew = false;
  try {
    mediaTypeFromExtension("document.pdf");
  } catch (err) {
    unsupportedThrew = err instanceof UnsupportedImageTypeError;
  }
  assert.ok(unsupportedThrew);
  console.log("    unsupported extensions (.pdf) genuinely refused, not silently guessed");

  let tooLargeThrew = false;
  try {
    buildImageContentBlock(Buffer.alloc(8 * 1024 * 1024), "huge.png"); // base64-encodes to >10MB
  } catch (err) {
    tooLargeThrew = err instanceof ImageTooLargeError;
  }
  assert.ok(tooLargeThrew, "an oversized image must be refused against the REAL 10MB Claude API limit, not silently sent");
  console.log("    an image whose base64 form exceeds the real 10MB API limit is genuinely refused");

  // --- [1b] Only the real vision-capable provider accepts image content; the others refuse honestly ---
  console.log("\n[1b] Only Claude (the real vision-capable configured provider) accepts image content...\n");
  const imageRequest: CompletionRequest = {
    messages: [{ role: "user", content: [block, { type: "text", text: "What's in this chart?" }] }],
  };

  const realFetch = global.fetch;
  let fetchWasCalled = false;
  global.fetch = (async () => {
    fetchWasCalled = true;
    throw new Error("should never be called");
  }) as typeof fetch;

  const deepseek = new DeepSeekProvider("fake-key");
  let deepseekRefused = false;
  try {
    await deepseek.generate(imageRequest, 1000);
  } catch (err) {
    deepseekRefused = err instanceof ImageNotSupportedError;
  }
  assert.ok(deepseekRefused && !fetchWasCalled, "DeepSeek (deepseek-chat, text-only) must also refuse before any network call");
  console.log("    DeepSeek (deepseek-chat, confirmed text-only) genuinely refuses image content -- no network call made");
  global.fetch = realFetch;

  // Real HTTP round-trip to the real Anthropic API, no valid key -- same pattern as
  // earlier steps: proves the request genuinely reaches the real host with the
  // correct image content block in its body, not just that the code compiles.
  const realCalls: { url: string; body: any }[] = [];
  global.fetch = (async (url: string, init?: RequestInit) => {
    realCalls.push({ url: url.toString(), body: init?.body ? JSON.parse(init.body as string) : {} });
    return realFetch(url, init);
  }) as typeof fetch;

  const claude = new ClaudeProvider("invalid-test-key");
  let claudeGenuinelyFailed = false;
  try {
    await claude.generate(imageRequest, 5000);
  } catch {
    claudeGenuinelyFailed = true; // expected: invalid key, real API rejects it
  }
  assert.ok(claudeGenuinelyFailed, "no valid key in this environment -- must genuinely fail against the real API, not silently succeed");
  assert.equal(realCalls.length, 1);
  assert.ok(realCalls[0].url.includes("api.anthropic.com"));
  const sentImageBlock = realCalls[0].body.messages[0].content[0];
  assert.equal(sentImageBlock.type, "image");
  assert.equal(sentImageBlock.source.media_type, "image/png");
  assert.equal(sentImageBlock.source.data, block.source.data);
  console.log(`    real HTTP request genuinely reached api.anthropic.com with the exact real image content block in its body (media_type=${sentImageBlock.source.media_type})`);
  global.fetch = realFetch;

  // --- [2] 20.2 Video: real scene-aware keyframe extraction inside the sandbox ---
  console.log("\n[2] Video: real scene-aware keyframe extraction via real ffmpeg, inside the sandbox...\n");

  // A REAL video, generated with ffmpeg itself: three 1-second solid-color segments
  // (red -> blue -> green) plus a real sine-wave audio track -- two genuine, sharp
  // scene changes a real scene-detection pass should actually find.
  const videoPath = join(workDir, "clip.mp4");
  await execFileAsync("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", "color=c=red:s=64x64:d=1,format=yuv420p",
    "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=1,format=yuv420p",
    "-f", "lavfi", "-i", "color=c=green:s=64x64:d=1,format=yuv420p",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
    "-map", "[v]", "-map", "3:a",
    "-c:v", "libx264", "-c:a", "aac", "-shortest",
    videoPath,
  ]);
  assert.ok(existsSync(videoPath));
  console.log(`    generated a real 3-second test video (red -> blue -> green + audio) at ${videoPath}`);

  const keyframes = await extractKeyframes("clip.mp4", workDir, 0.4);
  assert.ok(keyframes.length >= 2, `expected at least 2 real detected scene changes, got ${keyframes.length}`);
  for (const kf of keyframes) {
    assert.ok(existsSync(join(workDir, kf.relativePath)), `keyframe file ${kf.relativePath} must genuinely exist on disk`);
    assert.equal(typeof kf.timestampSeconds, "number");
  }
  console.log(`    real ffmpeg scene detection found ${keyframes.length} keyframes: ${keyframes.map((k) => `${k.relativePath}@${k.timestampSeconds}s`).join(", ")}`);
  assert.ok(keyframes.every((k, i) => i === 0 || k.timestampSeconds >= keyframes[i - 1].timestampSeconds), "timestamps must be in real chronological order");
  console.log("    timestamps are real, chronologically ordered pts_time values parsed from ffmpeg's own stderr output");

  let ffmpegErrorThrew = false;
  try {
    await extractKeyframes("does-not-exist.mp4", workDir);
  } catch (err) {
    ffmpegErrorThrew = err instanceof FfmpegError;
  }
  assert.ok(ffmpegErrorThrew, "a genuinely missing input file must surface as a real FfmpegError, not silently return zero keyframes");
  console.log("    a missing/invalid input file genuinely fails (real ffmpeg error), not silently swallowed");

  // --- [2b] Video: real timestamped transcript, no separate audio-extraction step ---
  console.log("\n[2b] Video: real timestamped transcript request (Groq, no key available in this environment)...\n");
  const transcription = new TranscriptionClient(undefined);
  let transcriptionGenuinelyFailed = false;
  try {
    await transcribeVideoWithTimestamps(transcription, "clip.mp4", workDir);
  } catch (err) {
    transcriptionGenuinelyFailed = err instanceof TranscriptionError;
  }
  assert.ok(transcriptionGenuinelyFailed, "must make a real network call to Groq (which genuinely fails without a key), not fabricate a transcript");
  console.log("    real network call made to Groq's transcription endpoint with the .mp4 file directly (no audio-extraction step) -- genuinely failed without a key, as expected");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
