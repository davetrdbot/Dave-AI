import assert from "node:assert/strict";
import { withThinkingIndicator, type TelegramClient } from "../src/index.js";

/**
 * Real bug fixed (trader, live: real pasted errors "⚠️ All configured providers failed: upstage
 * (request failed)." / "... nscale (timed out)." arrived as genuine new messages while the trader
 * insisted the bot was STILL visibly "thinking"/trading at the same time -- reading like a live
 * contradiction: failed AND still working).
 *
 * Root cause confirmed: NOT a race. `withThinkingIndicator`'s `task(indicator)` callback sends/
 * edits a real, persisted "guaranteed progress message" (e.g. "💹 get_open_positions") via
 * `indicator.update()` as each tool step runs. When the underlying provider call then hard-fails
 * (every configured provider exhausted) and `task()` throws, execution skipped straight past
 * `indicator.finalize()` -- the ONLY place that ever deleted that progress message -- and the old
 * `finally` block only stopped the heartbeat interval. The last progress message was silently
 * orphaned in the chat forever: a real, stale leftover from BEFORE the failure, not a live
 * contradiction. The caller's separate catch block then sent the real "All configured providers
 * failed" error as a brand-new message right next to that stale, never-cleaned-up "still working"
 * message -- exactly what the trader saw and correctly found suspicious.
 *
 * This test drives `withThinkingIndicator` with a task that sends one progress update and then
 * throws (simulating a hard "all providers failed" error deep in the agent loop), and asserts the
 * progress message is deleted before the error propagates -- no stale "still thinking" message left
 * behind.
 */

console.log("=== Real proof: a hard task() failure cleans up the stale progress message ===\n");

function makeClient() {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  let nextMessageId = 7001;
  const client = {
    sendChatAction: async () => true,
    sendRichMessageDraft: async () => true,
    sendMessage: async (body: Record<string, unknown>) => {
      const message_id = nextMessageId++;
      calls.push({ method: "sendMessage", body: { ...body, message_id } });
      return { message_id };
    },
    editMessageText: async (body: Record<string, unknown>) => {
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

console.log("[1] task() sends a progress update, then throws a hard provider-failure error...\n");
{
  const { client, calls } = makeClient();
  class AllProvidersFailed extends Error {}

  let caught: unknown;
  try {
    await withThinkingIndicator(client, 555444, async (indicator) => {
      // Mirrors the real onStep call: a real, visible "💹 checking what's open"-style progress
      // message gets sent before the hard failure happens.
      await indicator.update("trade", "get_open_positions");
      throw new AllProvidersFailed("All configured providers failed: upstage (request failed).");
    });
  } catch (err) {
    caught = err;
  }

  assert.ok(caught instanceof AllProvidersFailed, "the real error must still propagate to the caller (which sends the real error message)");

  const sendCalls = calls.filter((c) => c.method === "sendMessage");
  const deleteCalls = calls.filter((c) => c.method === "deleteMessage");
  console.log(`    sendMessage calls: ${sendCalls.length}, deleteMessage calls: ${deleteCalls.length}`);
  console.log(`    order: ${calls.map((c) => c.method).join(" -> ")}`);

  assert.equal(sendCalls.length, 1, "exactly one progress message was ever sent");
  assert.equal(deleteCalls.length, 1, "the progress message must be deleted on a hard failure -- no stale 'still thinking' leftover");
  assert.equal(deleteCalls[0].body.message_id, sendCalls[0].body.message_id, "must delete the exact progress message that was left showing");
}
console.log("\n[1] PASSED\n");

console.log("[2] task() throws before any update() ever ran -- must not error, nothing to clean up...\n");
{
  const { client, calls } = makeClient();
  let caught: unknown;
  try {
    await withThinkingIndicator(client, 555555, async () => {
      throw new Error("no stored keys for provider \"nscale\"");
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error);
  const deleteCalls = calls.filter((c) => c.method === "deleteMessage");
  assert.equal(deleteCalls.length, 0, "nothing to delete when no progress message was ever sent -- must not throw trying");
}
console.log("\n[2] PASSED\n");

console.log("=== ALL ASSERTIONS PASSED -- no more stale 'still thinking' message after a hard provider failure ===");
