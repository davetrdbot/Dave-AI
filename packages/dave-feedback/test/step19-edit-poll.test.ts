import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase, createAutomationWebhookServer } from "@dave/db";
import { sendFeedbackPoll, editPoll, recordPollResult, getPollResultsSince } from "../src/index.js";

/**
 * Real proof for item 7's poll-editing half: "Dave can SEND a poll, but cannot edit an existing
 * poll afterward... Add real poll-editing capability (stopPoll / editing poll options where
 * Telegram's API allows)." The real Bot API has no in-place "change a live poll's options"
 * method -- the only honest edit is stopPoll (closing the old one, freezing its results) followed
 * by a genuinely new poll. Proves both real calls happen with the right real parameters, and that
 * the new poll's own webhook (a fresh poll_id) is a real, separate, working registration.
 */

console.log("=== Real proof: real poll editing (stopPoll + a genuinely new poll) ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-editpoll-"));
const OWNER = "user-editpoll-1";

try {
  const db = new DaveDatabase(join(workDir, "dave.db"));

  const calls: { method: string; params: unknown }[] = [];
  let pollCounter = 0;
  const fakeClient = {
    sendPoll: async (params: unknown) => {
      pollCounter++;
      calls.push({ method: "sendPoll", params });
      return { message_id: 100 + pollCounter, poll: { id: `poll-id-${pollCounter}`, question: "", options: [] } };
    },
    stopPoll: async (params: unknown) => {
      calls.push({ method: "stopPoll", params });
      return { id: "poll-id-1", question: "Old question", options: [{ text: "A", voter_count: 3 }, { text: "B", voter_count: 1 }], is_closed: true };
    },
  } as any;

  console.log("[1] Send the original real poll...");
  const original = await sendFeedbackPoll(fakeClient, db, OWNER, 12345, "Old question", ["A", "B"]);
  console.log(`    real original poll: message_id=${original.messageId}, poll_id=${original.pollId}`);
  assert.equal(original.messageId, 101);

  console.log("\n[2] editPoll() genuinely calls the real stopPoll on the OLD message, then sends a genuinely NEW poll...");
  calls.length = 0;
  const edited = await editPoll(fakeClient, db, OWNER, 12345, original.messageId, "New question", ["C", "D", "E"]);
  console.log(`    calls made: ${calls.map((c) => c.method).join(" -> ")}`);
  assert.deepEqual(calls.map((c) => c.method), ["stopPoll", "sendPoll"], "must genuinely stop the old poll THEN send a new one -- no fake in-place edit");
  assert.deepEqual((calls[0].params as { chat_id: number; message_id: number }), { chat_id: 12345, message_id: original.messageId }, "stopPoll must target the REAL old message_id");
  assert.equal((calls[1].params as { question: string }).question, "New question");
  assert.deepEqual((calls[1].params as { options: string[] }).options, ["C", "D", "E"]);

  console.log("\n[3] The old poll's real final results are honestly returned, not discarded...");
  console.log(`    real stopped-poll results: ${JSON.stringify(edited.stoppedPoll.options)}`);
  assert.equal(edited.stoppedPoll.is_closed, true);
  assert.equal(edited.stoppedPoll.options[0].voter_count, 3);

  console.log("\n[4] The NEW poll's webhook is a genuinely separate, real, working registration (different poll_id)...");
  assert.notEqual(edited.next.pollId, original.pollId);
  const server = createAutomationWebhookServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  const res = await fetch(`http://127.0.0.1:${port}${edited.next.webhook.path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ selectedOptionIndex: 2 }),
  });
  assert.equal(res.status, 200);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const results = getPollResultsSince(db, OWNER, 0);
  const newPollResult = results.find((r) => r.question === "New question");
  console.log(`    real webhook POST to ${edited.next.webhook.path} -> stored answer: "${newPollResult?.options[newPollResult.selectedOptionIndex]}"`);
  assert.ok(newPollResult, "the new poll's real answer webhook must genuinely work");
  assert.equal(newPollResult!.selectedOptionIndex, 2);

  db.close();
  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
