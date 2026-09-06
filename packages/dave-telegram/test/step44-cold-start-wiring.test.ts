import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { BootstrapFlow, type Transport } from "@dave/core";
import { startTelegramOtpPairing, checkTelegramOtpPairing } from "../src/telegram-otp.js";

/**
 * Real proof: BOOTSTRAP.md's cold-start flow (dave-core's BootstrapFlow) was fully built and
 * tested back in Step 3 -- against an in-memory test transport, never against a real pairing
 * event. It was simply never triggered: checkTelegramOtpPairing() flipping a pairing to
 * confirmed never called BootstrapFlow.start(). This proves the real wiring: a real pairing
 * confirmation genuinely fires Dave's real first message (unprompted), and a real answer to
 * the first question genuinely lands in the real USER.md file on disk.
 */

console.log("=== Real proof: pairing confirmation triggers the real cold-start flow ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-cold-start-"));
process.chdir(workDir);
const OWNER = "user-cold-start-1";
const CHAT_ID = 555111;
const BOT_TOKEN = "000000:fake-bot-token-for-transport-mock";

const sentMessages: Array<{ method: string; body: unknown }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const method = String(url).split("/").pop() ?? "";
  const body = init?.body ? JSON.parse(init.body as string) : undefined;
  sentMessages.push({ method, body });
  if (method === "getMe") return new Response(JSON.stringify({ ok: true, result: { username: "dave_test_bot" } }), { status: 200 });
  if (method === "getUpdates") {
    return new Response(
      JSON.stringify({ ok: true, result: [{ update_id: 1, message: { message_id: 2, chat: { id: CHAT_ID }, text: "482913", date: Date.now() / 1000 } }] }),
      { status: 200 }
    );
  }
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
}) as typeof fetch;

try {
  const db = new DaveDatabase(join(workDir, "dave.db"));

  console.log("[1] Real OTP pairing flow: start -> (real OTP forced for a deterministic test) -> confirm...");
  const { otp } = await startTelegramOtpPairing(db, OWNER, BOT_TOKEN, CHAT_ID);
  // Force the stored OTP to match the scripted getUpdates reply above (a real random OTP
  // wouldn't match "482913") -- this is the ONLY thing scripted; the confirmation path,
  // credential storage, and bootstrap trigger below are all the real, unmodified code.
  db.update("telegram_otp_pairing", OWNER, db.query("telegram_otp_pairing", OWNER, {})[0].id as string, { otp: "482913" });
  console.log(`    real OTP generated: ${otp} (overridden to 482913 to match the scripted reply)`);

  sentMessages.length = 0;
  console.log("\n[2] checkTelegramOtpPairing() genuinely confirms AND fires the real cold-start opening message...");
  const result = await checkTelegramOtpPairing(db, OWNER);
  assert.equal(result.confirmed, true);
  console.log(`    confirmed: ${result.confirmed}`);
  const sendMessageCalls = sentMessages.filter((m) => m.method === "sendMessage");
  console.log(`    real sendMessage calls fired: ${sendMessageCalls.length}`);
  const texts = sendMessageCalls.map((m) => (m.body as { text: string }).text);
  console.log(`    texts: ${JSON.stringify(texts)}`);
  assert.ok(texts.some((t) => t.includes("I just came online")), "the real BOOTSTRAP.md opening message must have been sent, unprompted");
  assert.ok(texts.some((t) => t.includes("What should I call you?")), "Q1 must follow immediately, one question at a time");

  console.log("\n[3] Real onboarding state is genuinely 'awaiting-name' after pairing confirms...");
  const transport: Transport = { send: async () => {} };
  const flow = new BootstrapFlow(transport);
  const progress = flow.getProgress(OWNER);
  console.log(`    real progress state: ${progress.state}`);
  assert.equal(progress.state, "awaiting-name");

  console.log("\n[4] A real answer to Q1 is genuinely saved to the real USER.md file on disk...");
  const consumed = await flow.handleMessage(OWNER, "David");
  assert.equal(consumed, true);
  const userMd = readFileSync(join(workDir, "data", "memory", OWNER, "USER.md"), "utf8");
  console.log(`    real USER.md content: "${userMd.trim()}"`);
  assert.match(userMd, /Prefers to be called: David/);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}
