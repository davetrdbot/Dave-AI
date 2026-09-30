import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "dave-live-voice-"));
process.env.DAVE_DATA_ROOT = root;
process.env.DAVE_CREDENTIALS_KEY ??= "test-only-master-key-not-for-production";

/** The trader: "build the gemini live next" -- talking to Dave live, through Gemini Live. */
const { createAppChatHandler } = await import("../src/app-chat-routes.js");
const { toGeminiSchema, LIVE_MODELS } = await import("../src/live-voice.js");
const { sharedHistoryKey } = await import("../src/app-chat.js");
const { loadConversationHistory } = await import("../src/conversation-store.js");
const { activityAfter } = await import("../src/activity-bus.js");
const { DaveDatabase, hashDeviceToken } = await import("@dave/db");
const { setGeminiLiveKey } = await import("@dave/notifications");

console.log("=== Step 190: talk to Dave live (Gemini Live) ===\n");
const userId = "owner";

// Tools as the registry holds them: plain JSON Schema, an execute that records what it got.
const ran: { name: string; args: Record<string, unknown> }[] = [];
const tool = (name: string, parameters: unknown, out: unknown = { ok: true }) => ({
  name,
  description: `${name} tool`,
  parameters,
  execute: async (args: Record<string, unknown>) => {
    ran.push({ name, args });
    return out;
  },
});
const registry = {
  list: () => [
    tool("get_price", { type: "object", properties: { symbol: { type: "string" }, depth: { type: ["integer", "null"] } }, required: ["symbol"] }, { bid: 2650.1, ask: 2650.4 }),
    tool("set_breakeven", { type: "object", properties: { ticket: { type: "number" } }, required: ["ticket"] }),
    tool("run_script", { type: "object", properties: { code: { type: "string" } } }),
    tool("get_candles", { type: "object", properties: {} }, "x".repeat(20_000)),
  ],
};

// Google's token endpoint, faked: records what the bot asked for.
const tokenCalls: { url: string; key?: string; body: Record<string, unknown> }[] = [];
const fakeFetch = (async (url: string, init: RequestInit) => {
  const headers = init.headers as Record<string, string>;
  tokenCalls.push({ url, key: headers["x-goog-api-key"], body: JSON.parse(String(init.body)) });
  return new Response(JSON.stringify({ name: "auth_tokens/one-use-token" }), { status: 200 });
}) as unknown as typeof fetch;

const turns: string[] = [];
const token = "phone-token";
const statePath = join(root, "data", "device-auth", userId, "state.json");
mkdirSync(dirname(statePath), { recursive: true });
writeFileSync(statePath, JSON.stringify({ devices: [{ id: "d1", tokenHash: hashDeviceToken(token), label: "phone", pairedAt: 1 }] }));
const db = new DaveDatabase(join(root, "dave.db"));
const server = createServer(
  createAppChatHandler({
    userId,
    db,
    executor: {} as never,
    systemPrompt: "x",
    registry: registry as never,
    fetchImpl: fakeFetch,
    runTurn: async (_d, input) => {
      turns.push(input.text);
      return { status: "done", text: "Gold is bullish on H4, buy the pullback to 2640.", history: [], steps: [] } as never;
    },
  })
);
await new Promise<void>((r) => server.listen(0, r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/app/chat`;
const H = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const post = (path: string, body: unknown) => fetch(`${base}/${path}`, { method: "POST", headers: H, body: JSON.stringify(body) });

console.log("[1] Needs the phone's token and a Gemini key");
assert.equal((await fetch(`${base}/live/start`, { method: "POST", body: "{}" })).status, 401);
let r = await post("live/start", {});
assert.equal(r.status, 409);
assert.match(((await r.json()) as { error: string }).error, /Gemini API key/);
assert.equal(tokenCalls.length, 0);
console.log("   ✓\n");

console.log("[2] A one-use token from the trader's key; the phone never sees the key");
setGeminiLiveKey(db, userId, "AIzaTestKey1234567890");
r = await post("live/start", { thinking: true, voice: "Kore" });
assert.equal(r.status, 200, await r.clone().text());
const raw = await r.text();
assert.ok(!raw.includes("AIzaTestKey"), "the key never goes to the phone");
const s = JSON.parse(raw) as { url: string; token: string; model: string; setup: { setup: Record<string, any> } };
assert.equal(tokenCalls[0].key, "AIzaTestKey1234567890");
assert.match(tokenCalls[0].url, /\/v1alpha\/auth_tokens$/);
assert.equal(tokenCalls[0].body.uses, 1);
assert.deepEqual(tokenCalls[0].body.bidiGenerateContentSetup, s.setup.setup, "the token locks Dave's whole setup (instructions + tools) -- Google ignores the app's own");
assert.equal(s.model, LIVE_MODELS.thinking);
assert.equal(s.token, "auth_tokens/one-use-token");
assert.match(s.url, /^wss:\/\/.*BidiGenerateContentConstrained\?access_token=auth_tokens%2Fone-use-token$/);
const setup = s.setup.setup;
assert.equal(setup.model, `models/${LIVE_MODELS.thinking}`);
assert.deepEqual(setup.generationConfig.responseModalities, ["AUDIO"]);
assert.equal(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Kore");
assert.match(setup.systemInstruction.parts[0].text, /LIVE VOICE CALL/);
assert.ok(setup.inputAudioTranscription && setup.outputAudioTranscription, "both sides transcribed");
const decls = setup.tools[0].functionDeclarations as { name: string; parameters: any; description: string }[];
const names = decls.map((d) => d.name);
assert.deepEqual(names.sort(), ["ask_dave", "get_candles", "get_price", "set_breakeven"], "only the call's own tools -- no run_script");
const price = decls.find((d) => d.name === "get_price")!;
assert.deepEqual(price.parameters, { type: "OBJECT", properties: { symbol: { type: "STRING" }, depth: { type: "INTEGER", nullable: true } }, required: ["symbol"] });
const be = decls.find((d) => d.name === "set_breakeven")!;
assert.equal(be.parameters.properties.confirmed.type, "BOOLEAN", "trade actions carry confirmed");
assert.match(be.description, /wait for a clear yes/);
r = await post("live/start", { voice: "NotAVoice" });
assert.equal(((await r.json()) as typeof s).setup.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Charon", "unknown voice -> default");
assert.equal(tokenCalls[1].body.bidiGenerateContentSetup && (tokenCalls[1].body.bidiGenerateContentSetup as { model: string }).model, `models/${LIVE_MODELS.fast}`);
assert.deepEqual(setup.sessionResumption, {}, "calls can outlive Google's socket resets");
r = await post("live/start", { allowActions: false });
const ro = ((await r.json()) as typeof s).setup.setup;
assert.deepEqual((ro.tools[0].functionDeclarations as { name: string }[]).map((d) => d.name).sort(), ["ask_dave", "get_candles", "get_price"], "actions off: no trade tools on the call");
assert.match(ro.systemInstruction.parts[0].text, /can't change trades/);
console.log("   ✓\n");

console.log("[3] Tools run on the bot: reads free, trade actions only after a spoken yes");
r = await post("live/tool", { name: "get_price", args: { symbol: "XAUUSD" } });
assert.deepEqual(await r.json(), { result: { bid: 2650.1, ask: 2650.4 } });
r = await post("live/tool", { name: "set_breakeven", args: { ticket: 42 } });
assert.equal(((await r.json()) as { needsConfirmation?: boolean }).needsConfirmation, true);
assert.ok(!ran.some((x) => x.name === "set_breakeven"), "not run without a yes");
r = await post("live/tool", { name: "set_breakeven", args: { ticket: 42, confirmed: "yes" } });
assert.equal(((await r.json()) as { needsConfirmation?: boolean }).needsConfirmation, true, "only a real true counts");
r = await post("live/tool", { name: "set_breakeven", args: { ticket: 42, confirmed: true } });
assert.deepEqual(await r.json(), { result: { ok: true } });
assert.deepEqual(ran.at(-1), { name: "set_breakeven", args: { ticket: 42 } }, "confirmed is stripped before the tool runs");
r = await post("live/tool", { name: "run_script", args: { code: "rm -rf /" } });
assert.match(((await r.json()) as { error: string }).error, /isn't available on a voice call/);
assert.ok(!ran.some((x) => x.name === "run_script"));
r = await post("live/tool", { name: "get_candles", args: {} });
const big = (await r.json()) as { result: string; truncated: boolean };
assert.ok(big.truncated && big.result.length === 6000, "long results trimmed");
console.log("   ✓\n");

console.log("[4] ask_dave: a normal Dave turn, answered for speaking");
r = await post("live/tool", { name: "ask_dave", args: { request: "full analysis on gold" } });
assert.deepEqual(await r.json(), { answer: "Gold is bullish on H4, buy the pullback to 2640." });
assert.match(turns[0], /^\[From our voice call\] full analysis on gold/);
assert.match(turns[0], /read aloud/);
console.log("   ✓\n");

console.log("[5] The call is saved into the shared conversation");
r = await post("live/end", { seconds: 125, transcript: [{ who: "me", text: "move gold to breakeven" }, { who: "dave", text: "Done, gold is at breakeven." }, { who: "me", text: "  " }] });
assert.deepEqual(await r.json(), { saved: true });
const history = loadConversationHistory(db, sharedHistoryKey(db, userId));
const saved = history.find((m) => typeof m.content === "string" && m.content.startsWith("[Voice call"));
assert.ok(saved, "transcript in history");
assert.equal(saved!.content, "[Voice call with Dave, about 2 min -- transcript]\nMe: move gold to breakeven\nDave: Done, gold is at breakeven.");
r = await post("live/end", { seconds: 5, transcript: [] });
assert.deepEqual(await r.json(), { saved: false });
const texts = activityAfter(userId, 0).map((e) => String(e.data.text ?? ""));
assert.ok(texts.some((t) => /Voice call with Dave started/.test(t)));
assert.ok(texts.some((t) => /Voice call ended \(2 min\)/.test(t)));
assert.ok(!JSON.stringify(activityAfter(userId, 0)).includes("AIzaTestKey"), "the key never reaches the activity feed");
console.log("   ✓\n");

console.log("[6] Schema conversion edge cases");
assert.deepEqual(toGeminiSchema({ type: "array", items: { type: "string", enum: ["a", "b"] } }), { type: "ARRAY", items: { type: "STRING", enum: ["a", "b"] } });
assert.deepEqual(toGeminiSchema({ anyOf: [{ type: "string" }] }), { type: "STRING" });
assert.deepEqual(toGeminiSchema({ properties: { x: { type: "number" } }, required: ["x", "ghost"] }), { type: "OBJECT", properties: { x: { type: "NUMBER" } }, required: ["x"] });
console.log("   ✓\n");

server.close();
console.log("=== step190 live voice: ALL ASSERTIONS PASSED ===");
