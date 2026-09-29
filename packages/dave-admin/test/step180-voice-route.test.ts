import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workDir = mkdtempSync(join(tmpdir(), "dave-voice-route-"));
process.env.DAVE_DATA_ROOT = workDir;
process.env.DATA_DIR = join(workDir, "db");
process.env.DAVE_CREDENTIALS_KEY ??= "test-only-master-key-not-for-production";
delete process.env.OWNER_USER_ID;

const { NextRequest } = await import("next/server");
const { createPairingCode, redeemPairingCode } = await import("../server/device-auth.js");
const route = await import("../app/api/app/voice/route.js");
const { speakable } = await import("../server/speakable.js");

/** Dave's voice from the phone: ElevenLabs + Fish Audio keys, voice, preview, speak. */
console.log("=== Step 180: /api/app/voice ===\n");
const { code } = createPairingCode("default");
const { token } = redeemPairingCode("default", code, "phone");
type H = (r: InstanceType<typeof NextRequest>) => Promise<Response>;
const call = async (h: H, method: string, body?: unknown) => {
  const res = await h(new NextRequest("http://localhost/api/app/voice", { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }));
  return { status: res.status, json: (await res.json()) as any };
};

// Fake both providers' HTTP APIs.
const hits: string[] = [];
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  hits.push(`${init?.method ?? "GET"} ${u}`);
  if (u.includes("elevenlabs.io/v2/voices")) return new Response(JSON.stringify({ voices: [{ voice_id: "el-1", name: "Adam" }, { voice_id: "el-2", name: "Rachel" }] }));
  if (u.includes("elevenlabs.io/v1/text-to-speech/")) return new Response(Buffer.from("ID3-eleven"), { headers: { "content-type": "audio/mpeg" } });
  if (u.includes("api.fish.audio/model?self=true")) return new Response(JSON.stringify({ items: [{ _id: "fish-mine", title: "My Dave clone" }] }));
  if (u.includes("api.fish.audio/model?")) return new Response(JSON.stringify({ items: [{ _id: "fish-pop", title: "Narrator" }, { _id: "fish-mine", title: "My Dave clone" }] }));
  if (u.includes("api.fish.audio/v1/tts")) return new Response("quota exceeded", { status: 402 });
  return new Response("{}", { status: 404 });
}) as typeof fetch;

let r = await call(route.GET as H, "GET");
assert.equal(r.status, 200);
assert.deepEqual(r.json.providers.map((p: any) => [p.id, p.key]), [["elevenlabs", null], ["fish-audio", null]]);

r = await call(route.POST as H, "POST", { action: "voices", provider: "elevenlabs" });
assert.equal(r.status, 409, "no key yet");
r = await call(route.POST as H, "POST", { action: "key", provider: "elevenlabs", apiKey: "sk_elevenlabs_1234567890abcdef" });
assert.equal(r.json.providers[0].key.includes("1234567890"), false, "the key comes back masked");
await call(route.POST as H, "POST", { action: "key", provider: "fish-audio", apiKey: "fish_live_1234567890abcdef" });
console.log("   ✓ keys stored, masked");

r = await call(route.POST as H, "POST", { action: "voices", provider: "elevenlabs", query: "rach" });
assert.deepEqual(r.json.voices.map((v: any) => v.voiceId), ["el-2"]);
r = await call(route.POST as H, "POST", { action: "voices", provider: "fish-audio" });
assert.deepEqual(r.json.voices.map((v: any) => [v.voiceId, v.mine]), [["fish-mine", true], ["fish-pop", false]], "own clones first, no duplicates");
console.log("   ✓ voice lists for both providers");

r = await call(route.POST as H, "POST", { action: "preview", provider: "elevenlabs", voiceId: "el-2" });
assert.equal(Buffer.from(r.json.audio, "base64").toString(), "ID3-eleven");

await call(route.POST as H, "POST", { action: "voice", provider: "elevenlabs", voiceId: "el-2" });
await call(route.POST as H, "POST", { action: "voice", provider: "fish-audio", voiceId: "fish-mine" });
await call(route.POST as H, "POST", { action: "provider", provider: "fish-audio" });
r = await call(route.POST as H, "POST", { action: "speak", text: "**Gold** is up" });
assert.equal(r.status, 409, "switched off until the trader turns it on");
await call(route.POST as H, "POST", { action: "enabled", enabled: true });
r = await call(route.POST as H, "POST", { action: "speak", text: "**Gold** is up | 1R" });
assert.equal(r.status, 200, JSON.stringify(r.json));
assert.equal(r.json.provider, "elevenlabs");
assert.equal(r.json.usedFallback, true, "Fish out of credit -> ElevenLabs took over");
console.log("   ✓ preview, speak, fallback when the lead provider fails");

assert.equal(speakable("## Plan\n**Buy** XAUUSD | SL 2580 [chart](http://x)\n```code```"), "Plan Buy XAUUSD SL 2580 chart");
r = await call(route.POST as H, "POST", { action: "remove-key", provider: "fish-audio" });
assert.equal(r.json.providers[1].key, null);
console.log("   ✓ markdown stripped for speech; key removal");
// Gemini Live: a place for the key. Google checks it before it's kept; it only ever comes back masked.
{
  const realFetch = globalThis.fetch;
  const GOOD = "AIzaSyTESTgoodkey1234567890abcdefghij";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://generativelanguage.googleapis.com/")) {
      return new Response(JSON.stringify(url.includes(encodeURIComponent(GOOD)) ? { models: [] } : { error: { message: "API key not valid" } }), { status: url.includes(encodeURIComponent(GOOD)) ? 200 : 400 });
    }
    return realFetch(input as string, init);
  }) as typeof fetch;
  r = await call(route.GET as H, "GET");
  assert.equal(r.json.geminiLive.key, null, "no key yet");
  assert.match(r.json.geminiLive.link, /aistudio\.google\.com/);
  r = await call(route.POST as H, "POST", { action: "gemini-key", apiKey: "short" });
  assert.equal(r.status, 400);
  r = await call(route.POST as H, "POST", { action: "gemini-key", apiKey: "AIzaSyTESTbadkey00000000000000000000" });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Google says this key doesn't work/);
  r = await call(route.POST as H, "POST", { action: "gemini-key", apiKey: GOOD });
  assert.equal(r.status, 200);
  assert.ok(r.json.geminiLive.key && !r.json.geminiLive.key.includes("TESTgoodkey1234567890"), "masked, never the whole key");
  r = await call(route.POST as H, "POST", { action: "remove-gemini-key" });
  assert.equal(r.json.geminiLive.key, null);
  globalThis.fetch = realFetch;
  console.log("   ✓ Gemini Live key: checked with Google, saved masked, removable");
}
// Speech to text (Groq Whisper): the Groq key box. Checked with Groq, stored with the other Groq
// keys (so Telegram voice notes use it too), removable only if it was added here.
{
  const realFetch = globalThis.fetch;
  const GOOD = "gsk_TESTgoodgroqkey1234567890abcdef";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api.groq.com/")) {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      return new Response("{}", { status: auth === `Bearer ${GOOD}` ? 200 : 401 });
    }
    return realFetch(input as string, init);
  }) as typeof fetch;
  r = await call(route.GET as H, "GET");
  assert.equal(r.json.speechToText.count, 0);
  r = await call(route.POST as H, "POST", { action: "groq-key", apiKey: "gsk_TESTbadkey00000000000000000000" });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Groq says this key doesn't work/);
  r = await call(route.POST as H, "POST", { action: "groq-key", apiKey: GOOD });
  assert.equal(r.status, 200);
  assert.equal(r.json.speechToText.count, 1);
  assert.ok(r.json.speechToText.key && !r.json.speechToText.key.includes("TESTgoodgroqkey12345"), "masked");
  const { listProviderKeys } = await import("@dave/brain");
  const { DaveDatabase } = await import("@dave/db");
  const { dbPathFor } = await import("../server/db-path");
  const db2 = new DaveDatabase(dbPathFor("default"));
  assert.equal(listProviderKeys(db2, "default", "groq")[0].config.apiKey, GOOD, "stored as a Groq provider key -- the one transcription reads");
  db2.close();
  r = await call(route.POST as H, "POST", { action: "groq-key", apiKey: GOOD });
  assert.equal(r.json.speechToText.count, 1, "saving again replaces, doesn't pile up");
  r = await call(route.POST as H, "POST", { action: "remove-groq-key" });
  assert.equal(r.json.speechToText.count, 0);
  globalThis.fetch = realFetch;
  console.log("   ✓ Groq key for speech to text: checked, stored with the Groq keys, replace/remove");
}
console.log("\nAll Step 180 checks passed.");
process.exit(0);
