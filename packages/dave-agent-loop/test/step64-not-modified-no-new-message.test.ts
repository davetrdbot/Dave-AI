import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { TelegramClient } from "@dave/telegram";
import { dispatchCallback, type CommandRouterDeps } from "../src/command-router.js";

/**
 * Real proof for item 4, re-verified: "button interactions and sequential bot messages should
 * edit the existing message in place, not send a new message each time." The real root cause
 * found on re-audit: editMessageText's fallback ALWAYS fell back to sendMessage on ANY failure --
 * including Telegram's genuinely common real error "Bad Request: message is not modified", which
 * fires whenever the destination screen has the exact same text+keyboard already showing (e.g.
 * tapping Back to a screen you're already on, or tapping the same nav button twice). That's not a
 * real failure, but the blind catch treated it as one and sent a brand new message anyway --
 * exactly the "growing stack of messages" symptom reported. Proves a real before/after: the SAME
 * message_id, no new message sent, when Telegram genuinely returns "not modified".
 */

console.log("=== Real proof: a real 'message is not modified' response does NOT create a new message ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-not-modified-"));
const OWNER = "user-not-modified-1";
const CHAT_ID = 777111;
const MESSAGE_ID = 99;

const calls: { method: string; body: unknown }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const method = String(url).split("/").pop() ?? "";
  const body = init?.body ? JSON.parse(init.body as string) : undefined;
  calls.push({ method, body });
  if (method === "editMessageText") {
    // The exact real Telegram Bot API response shape for this exact real error.
    return new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message" }), { status: 400 });
  }
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
}) as typeof fetch;

try {
  const db = new DaveDatabase(join(workDir, "dave.db"));
  const client = new TelegramClient("000000:fake-token-for-transport-mock");
  const deps: CommandRouterDeps = { db, client, userId: OWNER, publicBaseUrl: "https://dave.example.com" };

  console.log("[1] Tap a nav button whose destination screen is (per Telegram's real response) identical to what's already shown...");
  calls.length = 0;
  await dispatchCallback(deps, { id: "cb1", data: "settings:top", message: { message_id: MESSAGE_ID, chat: { id: CHAT_ID } } } as never);

  console.log(`    real calls made: ${JSON.stringify(calls.map((c) => c.method))}`);
  const editCalls = calls.filter((c) => c.method === "editMessageText");
  const sendCalls = calls.filter((c) => c.method === "sendMessage");
  assert.equal(editCalls.length, 1, "a real editMessageText attempt must have been made");
  console.log(`    real editMessageText targeted message_id=${(editCalls[0].body as { message_id: number }).message_id}`);
  assert.equal((editCalls[0].body as { message_id: number }).message_id, MESSAGE_ID);

  console.log("\n[2] The real Telegram 'not modified' response must NOT trigger a fallback sendMessage -- before this fix, it always did...");
  console.log(`    real sendMessage calls: ${sendCalls.length} (must be 0)`);
  assert.equal(sendCalls.length, 0, "a genuine 'not modified' response must be treated as a silent success, never as a reason to send a brand new message");

  console.log("\n[3] A GENUINE edit failure (message too old / deleted) still correctly falls back to a new message...");
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = String(url).split("/").pop() ?? "";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, body });
    if (method === "editMessageText") {
      return new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: message to edit not found" }), { status: 400 });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 2 } }), { status: 200 });
  }) as typeof fetch;
  calls.length = 0;
  await dispatchCallback(deps, { id: "cb2", data: "settings:top", message: { message_id: MESSAGE_ID, chat: { id: CHAT_ID } } } as never);
  const sendCallsAfterRealFailure = calls.filter((c) => c.method === "sendMessage");
  console.log(`    real calls made: ${JSON.stringify(calls.map((c) => c.method))}`);
  assert.equal(sendCallsAfterRealFailure.length, 1, "a GENUINE edit failure must still fall back to a real new message -- the fix must not swallow real failures too");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}
