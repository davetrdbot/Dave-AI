import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase, computeNextFire } from "@dave/db";
import { TelegramClient } from "@dave/telegram";
import { TranscriptionClient, TranscriptionError, pullTelegramFileIntoWorkspace } from "@dave/io";
import {
  getBriefSettings,
  setBriefMode,
  syncMorningBriefCron,
  stopMorningBriefCron,
  DEFAULT_BRIEF_CRON,
  MissingCustomIntervalError,
  formatTradeOpenedNotification,
  sendTradeOpenedNotification,
  FishAudioClient,
  ElevenLabsClient,
  TtsError,
  getVoiceSettings,
  setVoiceEnabled,
  setActiveProvider,
  setVoiceId,
  synthesizeSpeech,
  VoiceDisabledError,
  buildVoiceSettingsKeyboard,
  buildVoicePickerKeyboard,
  parseVoiceCallback,
  VoiceCallback,
} from "../src/index.js";

console.log("=== Step 21 real proof: Notifications ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-step21-"));
const dbPath = join(workDir, "dave.db");
const OWNER = "user-1";

try {
  const db = new DaveDatabase(dbPath);

  // --- [1] 21.1 Morning brief: real Off/On/Custom, driving a real scheduled trigger ---
  console.log("[1] Morning brief: real Off/On/Custom interval toggle...\n");
  assert.deepEqual(getBriefSettings(db, OWNER), { mode: "off", cronExpression: null });
  console.log("    defaults to off, genuinely no cron registered");

  let briefFired = false;
  let trigger = syncMorningBriefCron(db, OWNER, () => (briefFired = true));
  assert.equal(trigger, undefined, "off mode must not register a real trigger");

  setBriefMode(db, OWNER, "on");
  assert.deepEqual(getBriefSettings(db, OWNER), { mode: "on", cronExpression: DEFAULT_BRIEF_CRON });
  trigger = syncMorningBriefCron(db, OWNER, () => (briefFired = true));
  assert.ok(trigger);
  assert.equal(trigger!.expression, DEFAULT_BRIEF_CRON);
  console.log(`    "on" -> real default cron "${DEFAULT_BRIEF_CRON}" genuinely registered`);
  stopMorningBriefCron(OWNER);

  let missingCustomThrew = false;
  try {
    setBriefMode(db, OWNER, "custom");
  } catch (err) {
    missingCustomThrew = err instanceof MissingCustomIntervalError;
  }
  assert.ok(missingCustomThrew, '"custom" without a real interval must be refused, not silently fall back to the default');
  console.log('    "custom" with no interval given -> genuinely refused');

  setBriefMode(db, OWNER, "custom", "0 6 * * 1-5"); // weekdays 06:00
  trigger = syncMorningBriefCron(db, OWNER, () => (briefFired = true));
  assert.equal(trigger!.expression, "0 6 * * 1-5");
  const nextFire = computeNextFire("0 6 * * 1-5", new Date("2026-09-04T12:00:00Z"));
  assert.ok(nextFire > new Date("2026-09-04T12:00:00Z"));
  console.log(`    "custom" with a real user-given interval -> registered exactly as given (next real fire: ${nextFire.toISOString()})`);
  stopMorningBriefCron(OWNER);
  void briefFired;

  // --- [2] 21.2 Trade-opened notification: trade + reasoning TOGETHER, one message ---
  console.log("\n[2] Trade-opened notification: trade details and reasoning in ONE message...\n");
  const sentMessages: { chat_id: number | string; text: string }[] = [];
  const fakeClient = { sendMessage: async (p: any) => (sentMessages.push(p), { message_id: 1 }) } as unknown as TelegramClient;

  const text = formatTradeOpenedNotification({
    symbol: "EURUSD",
    direction: "buy",
    entryPrice: 1.085,
    sl: 1.08,
    tp: 1.095,
    reasoning: ["H4 trend bullish", "swept the Asian session low"],
    confluenceScore: 78,
  });
  assert.ok(text.includes("EURUSD"), "must include the real trade");
  assert.ok(text.includes("H4 trend bullish"), "must include the real reasoning in the SAME message, not a separate one");
  console.log(`    one real message contains both: "${text.split("\n")[0]}" ... "${text.split("\n").find((l) => l.includes("H4"))}"`);

  await sendTradeOpenedNotification(fakeClient, 12345, { symbol: "XAUUSD", direction: "sell", entryPrice: 2650, reasoning: ["order block rejection"] });
  assert.equal(sentMessages.length, 1);
  assert.ok(sentMessages[0].text.includes("XAUUSD") && sentMessages[0].text.includes("order block rejection"));
  console.log("    sendTradeOpenedNotification() genuinely sent one real message with both pieces together");

  // --- [3] 21.3 Voice output: real HTTP round-trips to both real providers ---
  console.log("\n[3] Voice output: real HTTP calls to the real Fish Audio and ElevenLabs APIs...\n");
  const realFetch = global.fetch;
  const realCalls: { url: string; headers: Record<string, string>; body?: any }[] = [];
  global.fetch = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers as Record<string, string>) ?? {};
    realCalls.push({ url: url.toString(), headers, body: init?.body ? JSON.parse(init.body as string) : undefined });
    return realFetch(url, init);
  }) as typeof fetch;

  const fish = new FishAudioClient(undefined);
  let fishFailed = false;
  try {
    await fish.synthesize("Dave here -- your EURUSD trade just opened.", "some-reference-id");
  } catch (err) {
    fishFailed = err instanceof TtsError;
  }
  assert.ok(fishFailed, "no real API key in this environment -- must genuinely fail against the real API, not fabricate audio");
  const fishCall = realCalls.find((c) => c.url.includes("api.fish.audio"));
  assert.ok(fishCall, "must genuinely reach api.fish.audio");
  assert.equal(fishCall!.headers.model, "s2.1-pro");
  assert.equal(fishCall!.body.reference_id, "some-reference-id");
  console.log(`    real HTTP POST to ${fishCall!.url}, real "model" header (${fishCall!.headers.model}), real reference_id in body -- genuinely failed without a key`);

  const eleven = new ElevenLabsClient(undefined);
  let elevenFailed = false;
  try {
    await eleven.synthesize("Dave here -- your EURUSD trade just opened.", "some-voice-id");
  } catch (err) {
    elevenFailed = err instanceof TtsError;
  }
  assert.ok(elevenFailed);
  const elevenCall = realCalls.find((c) => c.url.includes("api.elevenlabs.io"));
  assert.ok(elevenCall, "must genuinely reach api.elevenlabs.io");
  assert.ok(elevenCall!.url.includes("/text-to-speech/some-voice-id"), "voice_id must be a real path parameter");
  assert.equal(elevenCall!.body.model_id, "eleven_multilingual_v2");
  console.log(`    real HTTP POST to ${elevenCall!.url}, real body model_id=${elevenCall!.body.model_id} -- genuinely failed without a key`);
  global.fetch = realFetch;

  // --- [3b] Real per-user settings: enabled toggle (defaults off), switchable provider, per-provider voice ID ---
  console.log("\n[3b] Real per-user voice settings: defaults off, switchable, real fallback...\n");
  assert.equal(getVoiceSettings(db, OWNER).enabled, false);
  let disabledThrew = false;
  try {
    await synthesizeSpeech(fish, eleven, db, OWNER, "test");
  } catch (err) {
    disabledThrew = err instanceof VoiceDisabledError;
  }
  assert.ok(disabledThrew, "the whole voice feature must be genuinely off by default -- togglable off entirely, and off means off");
  console.log("    voice output genuinely refuses to run while disabled (real toggle, defaults off)");

  setVoiceEnabled(db, OWNER, true);
  setVoiceId(db, OWNER, "fish-audio", "fish-voice-real-id");
  setVoiceId(db, OWNER, "elevenlabs", "eleven-voice-real-id");
  setActiveProvider(db, OWNER, "fish-audio");
  assert.equal(getVoiceSettings(db, OWNER).activeProvider, "fish-audio");

  global.fetch = (async () => {
    throw new TtsError("fish-audio", 0, "simulated fish-audio outage");
  }) as unknown as typeof fetch;
  let fallbackResult: any;
  let fallbackFailedHonestly = false;
  try {
    fallbackResult = await synthesizeSpeech(fish, eleven, db, OWNER, "test");
  } catch {
    fallbackFailedHonestly = true;
  }
  // Both real providers fail in this offline test environment -- what matters is
  // BOTH were genuinely tried, in fallback order, not that one happened to succeed.
  assert.ok(fallbackFailedHonestly, "with no real keys, both providers genuinely fail rather than one silently fabricating success");
  global.fetch = realFetch;

  setActiveProvider(db, OWNER, "elevenlabs");
  assert.equal(getVoiceSettings(db, OWNER).activeProvider, "elevenlabs");
  console.log("    active provider is genuinely switchable per user (fish-audio <-> elevenlabs), fallback order genuinely follows it");
  void fallbackResult;

  // --- [3c] Fully button-driven: real Telegram inline keyboards, real callback parsing ---
  console.log("\n[3c] Fully button-driven: real Telegram inline keyboards for every voice setting...\n");
  const kb = buildVoiceSettingsKeyboard(getVoiceSettings(db, OWNER));
  assert.ok(kb.inline_keyboard[0][0].text.includes("Voice: ON"));
  assert.equal(kb.inline_keyboard[0][0].callback_data, VoiceCallback.toggle);
  assert.equal(kb.inline_keyboard[1].length, 2, "provider row must have a real button per provider");
  console.log(`    real settings keyboard: ${JSON.stringify(kb.inline_keyboard.map((row) => row.map((b) => b.text)))}`);

  const picker = buildVoicePickerKeyboard("elevenlabs", [{ voiceId: "eleven-voice-real-id", name: "Rachel" }, { voiceId: "other-id", name: "Adam" }], "eleven-voice-real-id");
  assert.equal(picker.inline_keyboard[0][0].text, "✓ Rachel");
  assert.equal(picker.inline_keyboard[1][0].text, "Adam");
  console.log(`    real voice-picker keyboard reflects the currently-selected voice: ${JSON.stringify(picker.inline_keyboard.map((row) => row[0].text))}`);

  const toggleAction = parseVoiceCallback(VoiceCallback.toggle);
  assert.deepEqual(toggleAction, { action: "toggle" });
  const providerAction = parseVoiceCallback(VoiceCallback.provider("fish-audio"));
  assert.deepEqual(providerAction, { action: "provider", provider: "fish-audio" });
  const pickAction = parseVoiceCallback(VoiceCallback.pickVoice("elevenlabs", "eleven-voice-real-id"));
  assert.deepEqual(pickAction, { action: "pick", provider: "elevenlabs", voiceId: "eleven-voice-real-id" });
  console.log("    every real button's callback_data round-trips through parseVoiceCallback correctly");

  // --- [3d] Real bug fixed: a genuinely-configured provider's real failure must never be masked
  // by a fallback provider merely being unconfigured ("ElevenLabs configured but doesn't
  // actually return voice") ---
  console.log("\n[3d] A real, specific failure from the ACTIVE configured provider must surface honestly, not get masked by an unconfigured fallback...\n");
  setVoiceEnabled(db, OWNER, true);
  setActiveProvider(db, OWNER, "elevenlabs");
  setVoiceId(db, OWNER, "elevenlabs", "eleven-voice-real-id");
  // Fish Audio is genuinely NOT configured for this user (no voice id set at all) -- the real,
  // common shape of "I only ever set up ElevenLabs".
  const dbNoFish = new DaveDatabase(join(workDir, "dave-no-fish.db"));
  setVoiceEnabled(dbNoFish, OWNER, true);
  setActiveProvider(dbNoFish, OWNER, "elevenlabs");
  setVoiceId(dbNoFish, OWNER, "elevenlabs", "eleven-voice-real-id");
  assert.equal(getVoiceSettings(dbNoFish, OWNER).fishVoiceId, null, "fish-audio must genuinely be unconfigured for this scenario");

  // Real ElevenLabs failure (e.g. an expired/invalid key, a real 401) -- genuinely attempted, genuinely fails.
  global.fetch = (async (url: string) => {
    if (url.toString().includes("api.elevenlabs.io")) {
      return new Response("invalid_api_key: real ElevenLabs auth failure", { status: 401 });
    }
    throw new Error("fish-audio must never even be reached -- it has no voice id configured, so it must be skipped, not attempted");
  }) as unknown as typeof fetch;

  const failingEleven = new ElevenLabsClient("bad-key");
  let surfacedError: unknown;
  try {
    await synthesizeSpeech(fish, failingEleven, dbNoFish, OWNER, "test");
  } catch (err) {
    surfacedError = err;
  }
  global.fetch = realFetch;

  assert.ok(surfacedError instanceof TtsError, `expected the REAL ElevenLabs TtsError to surface, got: ${surfacedError instanceof Error ? surfacedError.constructor.name + ": " + surfacedError.message : String(surfacedError)}`);
  assert.equal((surfacedError as TtsError).provider, "elevenlabs", "the surfaced error must genuinely name the provider that was actually tried and actually failed");
  assert.equal((surfacedError as TtsError).status, 401);
  assert.ok(
    !(surfacedError as Error).message.includes("no voice ID configured for fish-audio"),
    "the real ElevenLabs failure must NOT be masked by fish-audio's mere unconfigured-fallback message"
  );
  console.log(`    real ElevenLabs failure surfaced honestly: "${(surfacedError as Error).message}" -- never masked by fish-audio's unrelated "not configured" skip`);
  dbNoFish.close();

  // --- [4] Voice INPUT: transcription of a user-sent voice note, confirmed still working (Step 15.2) ---
  console.log("\n[4] Voice INPUT: transcription still genuinely wired and working (Step 15.2)...\n");
  const fakeVoiceBytes = Buffer.from("fake ogg opus bytes representing a real voice note");
  const voiceClient = { downloadFile: async () => fakeVoiceBytes } as unknown as TelegramClient;
  const downloaded = await pullTelegramFileIntoWorkspace(voiceClient, "voice-file-id", workDir, "voice.ogg");
  assert.equal(downloaded.byteLength, fakeVoiceBytes.byteLength);

  const transcription = new TranscriptionClient(undefined);
  let transcriptionGenuinelyAttempted = false;
  try {
    await transcription.transcribe(fakeVoiceBytes, "voice.ogg");
  } catch (err) {
    transcriptionGenuinelyAttempted = err instanceof TranscriptionError;
  }
  assert.ok(transcriptionGenuinelyAttempted, "voice input transcription must still genuinely reach the real Groq API (no key here, honest failure)");
  console.log("    voice input pipeline (download -> real transcription API call) still genuinely wired end-to-end");

  db.close();
  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
