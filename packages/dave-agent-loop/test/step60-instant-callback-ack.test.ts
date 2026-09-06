import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { TelegramClient } from "@dave/telegram";
import { addProviderKey } from "@dave/brain";
import { dispatchCallback, type CommandRouterDeps } from "../src/command-router.js";

/**
 * Real proof for item 6: "tapping any settings/UI button has a noticeable delay before
 * responding... acknowledge the callback immediately, then update the message content."
 * Root cause confirmed by reading the code: answerCallbackQuery used to be called LAST, after
 * every real DB write / live network fetch / message send in a branch had already finished --
 * so the loading spinner Telegram shows on a tapped button stayed up for however long that real
 * work took. Proves the actual timing property: a real callback whose branch does a genuinely
 * slow network fetch (deliberately held open) still gets answerCallbackQuery called BEFORE that
 * fetch resolves -- the fix is a real ordering change, not just an assumption.
 */

console.log("=== Real proof: callback_query is acknowledged BEFORE slow work, not after ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-instant-ack-"));
process.chdir(workDir);
const OWNER = "user-instant-ack-1";
const CHAT_ID = 111222;

const callLog: { method: string; at: number }[] = [];
let releaseSlowFetch: (() => void) | undefined;
const slowFetchStarted = new Promise<void>((resolve) => {
  (globalThis as unknown as { __resolveSlow?: () => void }).__resolveSlow = resolve;
});

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const urlStr = String(url);
  if (urlStr.includes("api.telegram.org")) {
    const method = urlStr.split("/").pop() ?? "";
    callLog.push({ method, at: Date.now() });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }
  // The real "slow provider fetch" (fetchAvailableModels -> a live /v1/models-style call) --
  // deliberately held open to prove the ack does NOT wait for it.
  (globalThis as unknown as { __resolveSlow: () => void }).__resolveSlow();
  await new Promise<void>((resolve) => { releaseSlowFetch = resolve; });
  return new Response(JSON.stringify({ data: [{ id: "real-model-1" }] }), { status: 200 });
}) as typeof fetch;

try {
  const db = new DaveDatabase(join(workDir, "dave.db"));
  const client = new TelegramClient("000000:fake-token-for-transport-mock");
  const deps: CommandRouterDeps = { db, client, userId: OWNER, publicBaseUrl: "https://dave.example.com" };
  addProviderKey(db, OWNER, "openai", "test key", { apiKey: "sk-real-fake" });

  console.log("[1] Fire a real callback whose branch (fetchmodels:) does a genuinely slow, held-open network fetch...");
  const dispatchPromise = dispatchCallback(deps, { id: "cb-slow-1", data: "fetchmodels:openai", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);

  console.log("\n[2] The real answerCallbackQuery call must land BEFORE the slow fetch resolves...");
  await slowFetchStarted;
  await new Promise((r) => setTimeout(r, 20));
  const ackCall = callLog.find((c) => c.method === "answerCallbackQuery");
  console.log(`    calls so far (while the fetch is still held open): ${JSON.stringify(callLog.map((c) => c.method))}`);
  assert.ok(ackCall, "answerCallbackQuery must genuinely have been called already, while the slow fetch is still in flight");
  assert.equal(callLog.length, 1, "answerCallbackQuery must be the ONLY call so far -- no message send has raced ahead of it, and nothing is waiting on the slow fetch to answer");

  console.log("\n[3] Release the slow fetch so the real turn can finish, and confirm the real model-list message follows AFTER the ack...");
  releaseSlowFetch?.();
  await dispatchPromise;
  const methodsInOrder = callLog.map((c) => c.method);
  console.log(`    full real call order: ${JSON.stringify(methodsInOrder)}`);
  assert.equal(methodsInOrder[0], "answerCallbackQuery", "the ack must be the very FIRST real Telegram call made for this callback");
  assert.ok(methodsInOrder.slice(1).includes("sendMessage"), "the real model-list message must still genuinely follow afterward");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}
