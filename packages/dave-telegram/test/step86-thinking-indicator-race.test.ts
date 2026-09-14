import assert from "node:assert/strict";
import { ThinkingIndicator, type TelegramClient } from "../src/index.js";

/**
 * Real race-condition proof (user, live: "Dave: 💹 get_trade_history 📡 get_live_state" showed
 * up as two SEPARATE messages instead of one message updating live).
 *
 * Root cause: the real call site (telegram-bot-server.ts's `onStep`) invokes
 * `void indicator.update(...)` fire-and-forget, once per tool-call step, never awaited. The old
 * `updateGuaranteedProgressMessage()` did a non-atomic check-then-set on `progressMessageId`:
 *   if (this.progressMessageId === undefined) { await sendMessage(...); this.progressMessageId = ...; }
 * When two tool calls finish close together, a second `update()` can enter this method before the
 * first call's `sendMessage` has resolved -- both see `progressMessageId` as `undefined`, both
 * send a brand-new message instead of the second one editing the first.
 *
 * This test fires two updates back-to-back WITHOUT awaiting between them (the exact real calling
 * pattern), against a fake client whose sendMessage/editMessageText have an artificial delay to
 * simulate real network latency and give the race a real window to occur, then asserts exactly
 * ONE sendMessage call total and that the second update went through editMessageText against the
 * SAME message_id.
 */

console.log("=== Real proof: concurrent fire-and-forget update() calls do not both send a new message ===\n");

function makeDelayedClient(delayMs: number) {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  let nextMessageId = 9001;
  const client = {
    sendChatAction: async () => true,
    sendRichMessageDraft: async () => true,
    sendMessage: async (body: Record<string, unknown>) => {
      await new Promise((r) => setTimeout(r, delayMs));
      const message_id = nextMessageId++;
      calls.push({ method: "sendMessage", body: { ...body, message_id } });
      return { message_id };
    },
    editMessageText: async (body: Record<string, unknown>) => {
      await new Promise((r) => setTimeout(r, delayMs));
      calls.push({ method: "editMessageText", body });
      return { message_id: body.message_id as number };
    },
    deleteMessage: async (body: Record<string, unknown>) => {
      calls.push({ method: "deleteMessage", body });
      return true;
    },
    sendRichMessage: async () => ({ message_id: 999 }),
  } as unknown as TelegramClient;
  return { client, calls };
}

// --- Scenario 1: two concurrent updates racing while the first sendMessage is still in flight ---
console.log("[1] Two updates fired without awaiting between them, first sendMessage still in flight...\n");
{
  const { client, calls } = makeDelayedClient(40);
  const indicator = new ThinkingIndicator(client, 555111);
  await indicator.start();

  // Exactly the real call pattern: `void indicator.update(...)`, never awaited.
  const p1 = indicator.update("trade", "get_trade_history");
  const p2 = indicator.update("api", "get_live_state");
  await Promise.all([p1, p2]);

  const sendCalls = calls.filter((c) => c.method === "sendMessage");
  const editCalls = calls.filter((c) => c.method === "editMessageText");
  console.log(`    sendMessage calls: ${sendCalls.length}, editMessageText calls: ${editCalls.length}`);
  console.log(`    order: ${calls.map((c) => c.method).join(" -> ")}`);

  assert.equal(sendCalls.length, 1, "exactly ONE sendMessage call must happen even with two concurrent updates");
  const firstMessageId = sendCalls[0].body.message_id;
  for (const edit of editCalls) {
    assert.equal(edit.body.message_id, firstMessageId, "every edit must target the SAME message_id from the single sendMessage call");
  }
  indicator.stop();
}
console.log("\n[1] PASSED\n");

// --- Scenario 2: three concurrent updates, same assertion, higher contention ---
console.log("[2] Three updates fired without awaiting between them...\n");
{
  const { client, calls } = makeDelayedClient(30);
  const indicator = new ThinkingIndicator(client, 555222);
  await indicator.start();

  const p1 = indicator.update("memory", "recall_memory");
  const p2 = indicator.update("trade", "get_trade_history");
  const p3 = indicator.update("api", "get_live_state");
  await Promise.all([p1, p2, p3]);

  const sendCalls = calls.filter((c) => c.method === "sendMessage");
  console.log(`    sendMessage calls: ${sendCalls.length}`);
  console.log(`    order: ${calls.map((c) => c.method).join(" -> ")}`);
  assert.equal(sendCalls.length, 1, "exactly ONE sendMessage call must happen even with three concurrent updates");
  indicator.stop();
}
console.log("\n[2] PASSED\n");

// --- Scenario 3: finalize() itself can race an in-flight update() (a second, narrower window --
// finalize() runs from `withThinkingIndicator` right after the task callback returns, and since
// real callers never await `update()`, an update() call can still be mid-flight -- possibly not
// even as far as `sendMessage` yet -- when finalize() runs). Without waiting for it, finalize()
// would see no progress message to delete (orphaning it forever, since it arrives after finalize
// already sent the real final message with nothing left to clean it up). ---
console.log("[3] finalize() runs while an update() call is still mid-flight -- must not orphan the progress message...\n");
{
  const { client, calls } = makeDelayedClient(30);
  const indicator = new ThinkingIndicator(client, 555333);
  await indicator.start();

  // Fire-and-forget, deliberately not awaited -- exactly the real call pattern. finalize() (via
  // the immediate return below) can genuinely run before this has even reached sendMessage.
  void indicator.update("memory", "recall_memory");
  await indicator.finalize("Done despite the in-flight update.");

  const sendCalls = calls.filter((c) => c.method === "sendMessage");
  const deleteCalls = calls.filter((c) => c.method === "deleteMessage");
  console.log(`    sendMessage calls: ${sendCalls.length} (1 progress message + 1 real final answer), deleteMessage calls: ${deleteCalls.length}`);
  console.log(`    order: ${calls.map((c) => c.method).join(" -> ")}`);
  // Two REAL sendMessage calls are expected here: one for the guaranteed progress message
  // (from the in-flight update()), one for finalize()'s own real final-answer message -- that is
  // correct, not a bug. What matters is that the progress message is genuinely cleaned up.
  assert.equal(sendCalls.length, 2, "one progress-message send plus one real final-answer send");
  assert.equal(deleteCalls.length, 1, "finalize() must wait for the in-flight progress message and then delete it -- no orphan");
  assert.equal(deleteCalls[0].body.message_id, sendCalls[0].body.message_id, "must delete the exact progress message id that was still being created when finalize() ran");
  indicator.stop();
}
console.log("\n[3] PASSED\n");

console.log("=== ALL ASSERTIONS PASSED -- the race is fixed ===");
