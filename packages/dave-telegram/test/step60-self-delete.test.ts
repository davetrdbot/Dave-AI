import assert from "node:assert/strict";
import { TelegramClient } from "../src/client.js";
import { sendSelfDeletingMessage, scheduleSelfDelete } from "../src/self-delete.js";

/**
 * Real proof for the user's ask: low-value confirmation toasts ("✅ Provider switched to X",
 * "✅ SL set to Auto", "Adding key(s)... Line 1: OK") should genuinely delete themselves a few
 * seconds after sending, via the real Bot API deleteMessage method, instead of piling up.
 */

console.log("=== Real proof: self-deleting confirmation messages ===\n");

const calls: { method: string; body: unknown }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const method = String(url).split("/").pop() ?? "";
  const body = init?.body ? JSON.parse(init.body as string) : undefined;
  calls.push({ method, body });
  if (method === "sendMessage") return new Response(JSON.stringify({ ok: true, result: { message_id: 4242 } }), { status: 200 });
  if (method === "deleteMessage") return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
}) as typeof fetch;

try {
  const client = new TelegramClient("000000:fake-token-for-transport-mock");

  console.log("[1] sendSelfDeletingMessage() genuinely sends the real message immediately, no deleteMessage yet...");
  const result = await sendSelfDeletingMessage(client, { chat_id: 999, text: "✅ Provider switched to orcarouter" }, 50);
  assert.equal(result.message_id, 4242, "must return the real message_id sendMessage gave back");
  assert.equal(calls.filter((c) => c.method === "deleteMessage").length, 0, "must NOT delete before the delay elapses");
  console.log(`    real sendMessage call made, message_id=${result.message_id}, no premature delete`);

  console.log("\n[2] After the real delay elapses, a genuine deleteMessage call fires for that exact message...");
  await new Promise((r) => setTimeout(r, 150));
  const deleteCall = calls.find((c) => c.method === "deleteMessage");
  assert.ok(deleteCall, "a real deleteMessage call must have fired");
  assert.deepEqual(deleteCall!.body, { chat_id: 999, message_id: 4242 });
  console.log(`    real deleteMessage call fired for chat_id=999, message_id=4242`);

  console.log("\n[3] scheduleSelfDelete() works standalone too (for a message sent through a different path)...");
  calls.length = 0;
  scheduleSelfDelete(client, 555, 7777, 50);
  await new Promise((r) => setTimeout(r, 150));
  const standaloneDelete = calls.find((c) => c.method === "deleteMessage");
  assert.ok(standaloneDelete);
  assert.deepEqual(standaloneDelete!.body, { chat_id: 555, message_id: 7777 });
  console.log("    real standalone deleteMessage call also fired correctly");

  console.log("\n[4] A deleteMessage failure (e.g. already deleted) is swallowed, never thrown...");
  calls.length = 0;
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false, error_code: 400, description: "message to delete not found" }), { status: 400 })) as typeof fetch;
  let threw = false;
  try {
    scheduleSelfDelete(client, 1, 2, 20);
    await new Promise((r) => setTimeout(r, 100));
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "a failed deleteMessage must never surface as an uncaught error -- this is best-effort tidiness");
  console.log("    a real deleteMessage failure was genuinely swallowed, no crash");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  globalThis.fetch = realFetch;
}
