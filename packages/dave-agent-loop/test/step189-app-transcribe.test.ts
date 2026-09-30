import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "dave-transcribe-"));
process.env.DAVE_DATA_ROOT = root;
process.env.DAVE_CREDENTIALS_KEY ??= "test-only-master-key-not-for-production";

/** The trader: "the Groq API for the Whisper, so when I'm talking to Dave ... it transcribes perfectly". */
const { createAppChatHandler } = await import("../src/app-chat-routes.js");
const { speechVocabularyPrompt } = await import("../src/speech-vocabulary.js");
const { DaveDatabase, hashDeviceToken } = await import("@dave/db");
const { addProviderKey } = await import("@dave/brain");
const { upsertGroup, setActiveGroup } = await import("@dave/trading");

console.log("=== Step 189: talk to Dave -> Groq Whisper ===\n");
const userId = "owner";

// A stand-in for Groq's transcription endpoint that records what it was sent.
const seen: { model?: string; prompt?: string; language?: string; bytes?: number; auth?: string }[] = [];
const groq = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const form = await new Request("http://x", { method: "POST", headers: { "content-type": String(req.headers["content-type"]) }, body: Buffer.concat(chunks) }).formData();
  const file = form.get("file") as Blob;
  seen.push({ model: String(form.get("model")), prompt: String(form.get("prompt") ?? ""), language: String(form.get("language") ?? ""), bytes: file.size, auth: req.headers.authorization });
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ text: " Move my XAUUSD trade to breakeven. ", segments: [] }));
});
await new Promise<void>((r) => groq.listen(0, r));
const groqUrl = `http://127.0.0.1:${(groq.address() as { port: number }).port}`;

const token = "phone-token";
const statePath = join(root, "data", "device-auth", userId, "state.json");
mkdirSync(dirname(statePath), { recursive: true });
writeFileSync(statePath, JSON.stringify({ devices: [{ id: "d1", tokenHash: hashDeviceToken(token), label: "phone", pairedAt: 1 }] }));
const db = new DaveDatabase(join(root, "dave.db"));
const server = createServer(createAppChatHandler({ userId, db, executor: {} as never, systemPrompt: "x", runTurn: async () => undefined }));
await new Promise<void>((r) => server.listen(0, r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/app/chat`;
const H = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const audio = Buffer.alloc(4000, 7).toString("base64");

console.log("[1] Needs the phone's token, a real recording, and a Groq key");
assert.equal((await fetch(`${base}/transcribe`, { method: "POST", body: "{}" })).status, 401);
let r = await fetch(`${base}/transcribe`, { method: "POST", headers: H, body: JSON.stringify({ audio: "AAAA" }) });
assert.equal(r.status, 400);
r = await fetch(`${base}/transcribe`, { method: "POST", headers: H, body: JSON.stringify({ audio }) });
assert.equal(r.status, 409);
assert.match(((await r.json()) as { error: string }).error, /Add a Groq key first/);
console.log("   ✓\n");

console.log("[2] Groq's most accurate Whisper, primed with the trader's own pairs and trading words");
upsertGroup(userId, { id: "syn", name: "Synthetic", symbols: ["Volatility 75 Index", "Boom 1000 Index"] });
setActiveGroup(userId, "syn");
addProviderKey(db, userId, "groq", "Speech to text", { apiKey: "gsk_test_key_1234567890", baseUrlOverride: groqUrl });
r = await fetch(`${base}/transcribe`, { method: "POST", headers: H, body: JSON.stringify({ audio, name: "talk.m4a" }) });
assert.equal(r.status, 200, await r.clone().text());
assert.deepEqual(await r.json(), { text: "Move my XAUUSD trade to breakeven." }, "trimmed text back to the app");
const call = seen[0];
assert.equal(call.model, "whisper-large-v3", "the accurate model, not turbo");
assert.equal(call.language, "en");
assert.equal(call.bytes, 4000, "the whole recording went through");
assert.equal(call.auth, "Bearer gsk_test_key_1234567890");
assert.match(call.prompt!, /Volatility 75 Index/, "the trader's own pairs");
assert.match(call.prompt!, /breakeven/);
assert.match(call.prompt!, /XAUUSD/);
assert.ok(speechVocabularyPrompt(userId).length <= 800, "short enough for Whisper to read all of it");
console.log(`   prompt: ${call.prompt!.slice(0, 120)}...`);
console.log("   ✓\n");

console.log("[3] A call in Dave's ElevenLabs voice: what you said -> Dave's full brain -> his voice");
{
  const { setTtsProviderKey, setVoiceEnabled, setActiveProvider, setVoiceId } = await import("@dave/notifications");
  const turns: { text: string; display?: { text: string } }[] = [];
  const callServer = createServer(
    createAppChatHandler({
      userId, db, executor: {} as never, systemPrompt: "x",
      runTurn: (async (_d: unknown, input: { text: string; display?: { text: string } }) => {
        turns.push(input);
        return { status: "done", text: "Done -- **XAUUSD** stop is at breakeven, 2,351.40." };
      }) as never,
    })
  );
  await new Promise<void>((r2) => callServer.listen(0, r2));
  const callBase = `http://127.0.0.1:${(callServer.address() as { port: number }).port}/api/app/chat`;
  // No voice set up yet: the answer still comes back as text, with why there's no audio.
  let v = await fetch(`${callBase}/voice/turn`, { method: "POST", headers: H, body: JSON.stringify({ audio, name: "call.m4a" }) });
  let j = (await v.json()) as Record<string, string>;
  assert.equal(j.heard, "Move my XAUUSD trade to breakeven.");
  assert.match(j.reply, /stop is at breakeven/);
  assert.ok(j.voiceError && !j.audio, "no voice yet -- the reason, not a failure");
  assert.match(turns[0].text, /^\[Voice call -- the trader said:\] Move my XAUUSD trade to breakeven\./, "Dave's full turn gets what was said");
  assert.match(turns[0].text, /wait for their yes/, "trade changes need a spoken yes");
  assert.equal(turns[0].display?.text, "🎙 Move my XAUUSD trade to breakeven.", "the chat shows what was said");
  // With ElevenLabs: the reply comes back as his voice, markdown stripped before it's spoken.
  setTtsProviderKey(db, userId, "elevenlabs", "el_test_key_1234567890");
  setVoiceEnabled(db, userId, true);
  setActiveProvider(db, userId, "elevenlabs");
  setVoiceId(db, userId, "elevenlabs", "voice-dave");
  const realFetch = globalThis.fetch;
  let spokenText = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = String(input);
    if (u.startsWith("https://api.elevenlabs.io/v1/text-to-speech/voice-dave")) {
      spokenText = JSON.parse(String(init?.body)).text;
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-type": "audio/mpeg" } });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    v = await realFetch(`${callBase}/voice/turn`, { method: "POST", headers: H, body: JSON.stringify({ audio, name: "call.m4a" }) });
    j = (await v.json()) as Record<string, string>;
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(j.audio, Buffer.from([1, 2, 3, 4]).toString("base64"), "Dave's ElevenLabs voice comes back");
  assert.equal(j.provider, "elevenlabs");
  assert.ok(!spokenText.includes("**") && spokenText.includes("XAUUSD"), "markdown stripped before speaking");
  callServer.close();
}
console.log("   ✓\n");

server.close();
groq.close();
console.log("=== step189 app transcribe: ALL ASSERTIONS PASSED ===");
