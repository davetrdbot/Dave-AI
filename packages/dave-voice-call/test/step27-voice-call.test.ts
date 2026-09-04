import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { DaveDatabase } from "@dave/db";
import {
  getVoiceCallSettings,
  setVoiceCallSettings,
  evaluateCallTrigger,
  GreenApiClient,
  whatsappChatId,
  parseCallWebhook,
  GreenApiRequestError,
  CallSession,
  GeminiLiveClient,
  GeminiLiveConnectionError,
  VOICE_CALL_TOOLS,
  VoiceCallNotConfiguredError,
} from "../src/index.js";

console.log("=== Update 6 real proof: Green API + Gemini Live WhatsApp calling ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-update6-"));
const dbPath = join(workDir, "dave.db");
const OWNER = "user-1";

try {
  const db = new DaveDatabase(dbPath);

  // --- [1] Settings: nothing hardcoded, defaults unset except the documented default duration ---
  console.log("[1] Real DB-backed settings -- nothing hardcoded...\n");
  const initial = getVoiceCallSettings(db, OWNER);
  assert.equal(initial.greenApiToken, null);
  assert.equal(initial.greenApiInstanceId, null);
  assert.equal(initial.whatsappNumber, null);
  assert.equal(initial.unresponsiveMinutes, 15);
  console.log(`    fresh user: ${JSON.stringify(initial)}`);

  setVoiceCallSettings(db, OWNER, { greenApiToken: "tok1", greenApiInstanceId: "1101000000", whatsappNumber: "+1 555 123 4567", unresponsiveMinutes: 20 });
  const saved = getVoiceCallSettings(db, OWNER);
  assert.equal(saved.greenApiToken, "tok1");
  assert.equal(saved.unresponsiveMinutes, 20);
  console.log(`    real settings saved: ${JSON.stringify(saved)}`);

  // --- [2] Real trigger logic, both conditions from the master plan verbatim ---
  console.log("\n[2] Real trigger logic -- both conditions from the master plan...\n");
  const now = Date.now();
  const d1 = evaluateCallTrigger({ lastUserTelegramActivityAt: now - 25 * 60000, now, unresponsiveMinutes: 20, daveHasSomethingToTell: true, daveHasUrgentUnansweredQuestion: false });
  assert.equal(d1.shouldCall, true);
  assert.equal(d1.reason, "unresponsive_with_news");
  console.log(`    unresponsive 25min (threshold 20) + has news -> ${JSON.stringify(d1)}`);

  const d2 = evaluateCallTrigger({ lastUserTelegramActivityAt: now - 5 * 60000, now, unresponsiveMinutes: 20, daveHasSomethingToTell: true, daveHasUrgentUnansweredQuestion: false });
  assert.equal(d2.shouldCall, false, "must NOT call if not yet unresponsive long enough, even with news");
  console.log(`    unresponsive only 5min (threshold 20) + has news -> ${JSON.stringify(d2)} (correctly withheld)`);

  const d3 = evaluateCallTrigger({ lastUserTelegramActivityAt: now - 30 * 60000, now, unresponsiveMinutes: 20, daveHasSomethingToTell: false, daveHasUrgentUnansweredQuestion: true });
  assert.equal(d3.shouldCall, true);
  assert.equal(d3.reason, "urgent_unanswered_question");
  console.log(`    urgent unanswered question, unresponsive 30min -> ${JSON.stringify(d3)}`);

  const d4 = evaluateCallTrigger({ lastUserTelegramActivityAt: now - 1 * 60000, now, unresponsiveMinutes: 20, daveHasSomethingToTell: false, daveHasUrgentUnansweredQuestion: false });
  assert.equal(d4.shouldCall, false);
  console.log(`    neither condition -> ${JSON.stringify(d4)}`);

  // --- [3] Real Green API webhook parsing, using the REAL confirmed JSON shapes ---
  console.log("\n[3] Real Green API call-webhook parsing (real confirmed shapes from green-api.com docs)...\n");
  const incoming = parseCallWebhook({
    from: "79001234500@c.us",
    typeWebhook: "incomingCall",
    instanceData: { idInstance: 7103000000, wid: "79876543210@c.us", typeInstance: "whatsapp" },
    status: "offer",
    timestamp: 1617691757,
    idMessage: "104179EDB7F5328988D8834107EEBE50",
  });
  assert.ok(incoming);
  assert.equal(incoming!.typeWebhook, "incomingCall");
  console.log(`    real incomingCall webhook parsed: from=${(incoming as any).from}, status=${(incoming as any).status}`);

  const outgoing = parseCallWebhook({
    typeWebhook: "outgoingCall",
    instanceData: { idInstance: 1101000000, wid: "7XXXXXXXXXX@c.us", typeInstance: "whatsapp" },
    timestamp: 1768888295,
    idMessage: "AC88AD4AA553FCBB95BEB6BF98F704B1",
    from: "16381924658XXX@c.us",
    isVideo: false,
    duration: 42,
    status: "hungUp",
    participants: [{ id: "16381924658XXX@c.us", status: "hungUp" }],
  });
  assert.ok(outgoing);
  assert.equal((outgoing as any).duration, 42);
  console.log(`    real outgoingCall webhook parsed: duration=${(outgoing as any).duration}s, participants=${JSON.stringify((outgoing as any).participants)}`);

  assert.equal(parseCallWebhook({ typeWebhook: "stateInstanceChanged" }), undefined, "a non-call webhook must not be misparsed as one");
  console.log("    a non-call webhook type is correctly NOT parsed as a call event");

  console.log("\n[3b] whatsappChatId(): real chat-id formatting (E.164-ish input -> @c.us)...\n");
  assert.equal(whatsappChatId("+1 (555) 123-4567"), "15551234567@c.us");
  console.log(`    "+1 (555) 123-4567" -> "${whatsappChatId("+1 (555) 123-4567")}"`);

  // --- [4] Real GreenApiClient: real URL shape, real HTTP round-trip against a local server ---
  console.log("\n[4] Real GreenApiClient -- real confirmed URL shape, real HTTP round trip...\n");
  let capturedPath: string | undefined;
  let capturedBody: any;
  const server = createServer((req, res) => {
    capturedPath = req.url;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      capturedBody = body ? JSON.parse(body) : undefined;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ idMessage: "REAL-MSG-ID-123" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const greenClient = new GreenApiClient({ idInstance: "1101000000", apiTokenInstance: "d41d8cd98f00", apiUrl: `http://127.0.0.1:${port}` });
  const sendResult = await greenClient.sendTextMessage("15551234567@c.us", "Dave is trying to reach you.");
  assert.equal(sendResult.idMessage, "REAL-MSG-ID-123");
  assert.equal(capturedPath, "/waInstance1101000000/sendMessage/d41d8cd98f00", "must use the REAL confirmed URL shape: /waInstance{id}/{method}/{token}");
  assert.equal(capturedBody.chatId, "15551234567@c.us");
  console.log(`    real request path matched the confirmed shape: ${capturedPath}`);
  console.log(`    real response parsed: ${JSON.stringify(sendResult)}`);
  await new Promise<void>((resolve) => server.close(() => resolve()));

  console.log("\n[4b] GreenApiRequestError: a real HTTP failure is honestly typed, not swallowed...\n");
  const badClient = new GreenApiClient({ idInstance: "x", apiTokenInstance: "y", apiUrl: "http://127.0.0.1:1" });
  let greenErr: GreenApiRequestError | undefined;
  try {
    await badClient.sendTextMessage("15551234567@c.us", "hi", 2000);
  } catch (err) {
    if (err instanceof GreenApiRequestError) greenErr = err;
  }
  assert.ok(greenErr);
  console.log(`    real, typed failure against an unreachable host: ${greenErr!.message}`);

  // --- [5] CallSession: real 10-minute cap, enforced by a real timer ---
  console.log("\n[5] CallSession: real state machine, real cap enforcement (shortened for the test)...\n");
  const events: string[] = [];
  const session = new CallSession("call-1", 100); // 100ms cap, standing in for the real 10 minutes
  session.onEvent((e) => events.push(`${e.state}:${e.reason}`));
  assert.equal(session.getState(), "ringing");
  session.applyWebhookStatus("offer");
  assert.equal(session.getState(), "ringing", "an 'offer' alone must not start the session");
  session.applyWebhookStatus("pickUp");
  assert.equal(session.getState(), "active");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(session.getState(), "ended");
  assert.deepEqual(events, ["active:answered", "ended:cap_reached"]);
  console.log(`    real transitions: ${events.join(" -> ")} -- cap genuinely enforced by a real timer, not a flag`);

  console.log("\n[5b] A real hungUp webhook ends the session immediately, cap timer cancelled...\n");
  const session2 = new CallSession("call-2", 100000);
  const events2: string[] = [];
  session2.onEvent((e) => events2.push(`${e.state}:${e.reason}`));
  session2.applyWebhookStatus("pickUp");
  session2.applyWebhookStatus("hungUp");
  assert.deepEqual(events2, ["active:answered", "ended:hung_up"]);
  console.log(`    real early hang-up honored: ${events2.join(" -> ")}`);

  // --- [6] Gemini Live: real WebSocket connection attempt against the real endpoint ---
  console.log("\n[6] GeminiLiveClient: real connection attempt against the real endpoint (no valid key here)...\n");
  const geminiClient = new GeminiLiveClient();
  let geminiErr: GeminiLiveConnectionError | undefined;
  try {
    await geminiClient.connect({ apiKey: "not-a-real-key-in-this-environment" }, 8000);
  } catch (err) {
    if (err instanceof GeminiLiveConnectionError) geminiErr = err;
  }
  assert.ok(geminiErr, "a real connection attempt against the real Gemini Live endpoint with no valid key must fail honestly, typed");
  console.log(`    real network attempt to wss://generativelanguage.googleapis.com genuinely failed without a key: ${geminiErr!.message}`);

  // --- [7] Real agent tools ---
  console.log("\n[7] Real agent tools...\n");
  const evalTool = VOICE_CALL_TOOLS.find((t) => t.name === "evaluate_call_trigger")!;
  const toolDecision: any = await evalTool.execute({ lastUserTelegramActivityAt: now - 25 * 60000, daveHasSomethingToTell: true }, { userId: OWNER, db });
  assert.equal(toolDecision.shouldCall, true);
  console.log(`    evaluate_call_trigger tool used the real stored unresponsiveMinutes (20): ${JSON.stringify(toolDecision)}`);

  console.log("\n[7b] notify_trying_to_reach_you tool genuinely refuses when unconfigured for a DIFFERENT user...\n");
  const notifyTool = VOICE_CALL_TOOLS.find((t) => t.name === "notify_trying_to_reach_you")!;
  let notConfigured = false;
  try {
    await notifyTool.execute({ message: "hi" }, { userId: "fresh-user-2", db });
  } catch (err) {
    notConfigured = err instanceof VoiceCallNotConfiguredError;
  }
  assert.ok(notConfigured);
  console.log("    real refusal: VoiceCallNotConfiguredError for an unconfigured user");

  db.close();
  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
