import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import type { CompletionMessage } from "@dave/brain";
import { saveConversationHistory, loadConversationHistory } from "../src/conversation-store.js";

/**
 * Real bug fixed (user, with a real provider error: "Tool message with tool_call_id 'call_xxx'
 * not found in assistant tool calls. Available tool call IDs: []"): the old trim did a blind
 * slice from the end of history, which could cut an assistant's real toolCalls message away from
 * the "tool" role message(s) answering it -- an orphaned tool-result message with no matching
 * assistant call anywhere in the retained history, which every real provider correctly rejects.
 * This proves trimming never splits a tool_call/tool_result pair apart, using a real DB round trip
 * (save -> load), not just calling an internal function directly.
 */

console.log("=== Real proof: history trimming never orphans a tool_call_id ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-history-trim-"));
const USER_ID = "user-history-trim-1";

function assertNoOrphanedToolMessages(history: CompletionMessage[]): void {
  const knownCallIds = new Set<string>();
  for (const msg of history) {
    if (msg.role === "assistant" && msg.toolCalls) {
      for (const call of msg.toolCalls) knownCallIds.add(call.id);
    }
  }
  for (const msg of history) {
    if (msg.role === "tool") {
      assert.ok(msg.toolCallId && knownCallIds.has(msg.toolCallId), `orphaned tool message found: toolCallId="${msg.toolCallId}" has no matching assistant tool call in the retained history`);
    }
  }
}

try {
  const db = new DaveDatabase(join(workDir, "dave.db"));

  console.log("[1] A long real history (multi-tool-call turns) that would trigger the old bug at the trim boundary...\n");
  const history: CompletionMessage[] = [{ role: "system", content: "You are Dave." }];
  // Build 40 "turns", each: a user message, an assistant message with 2 real tool calls, and 2
  // real tool-result messages -- exactly the shape that previously landed an orphaned tool
  // message right at the MAX_MESSAGES=60 cut boundary.
  for (let i = 0; i < 40; i++) {
    history.push({ role: "user", content: `Message ${i}` });
    const id1 = `call_${i}_a`;
    const id2 = `call_${i}_b`;
    history.push({
      role: "assistant",
      content: "",
      toolCalls: [
        { id: id1, name: "get_price", arguments: { symbol: "EURUSD" } },
        { id: id2, name: "get_price", arguments: { symbol: "GBPUSD" } },
      ],
    });
    history.push({ role: "tool", toolCallId: id1, content: JSON.stringify({ price: 1.1 }) });
    history.push({ role: "tool", toolCallId: id2, content: JSON.stringify({ price: 1.27 }) });
  }
  console.log(`    built ${history.length} real messages across 40 turns`);

  console.log("\n[2] Real save -> trim -> load round trip through the actual DB...\n");
  saveConversationHistory(db, USER_ID, history);
  const loaded = loadConversationHistory(db, USER_ID);
  assert.ok(loaded.length < history.length, "real trimming must genuinely have happened");
  assert.equal(loaded[0].role, "system", "the leading system message must survive");
  assertNoOrphanedToolMessages(loaded);
  console.log(`    trimmed from ${history.length} -> ${loaded.length} messages, zero orphaned tool_call_ids`);

  console.log("\n[3] Every retained assistant tool-call turn keeps ALL of its real tool results (never partial)...\n");
  for (let i = 0; i < loaded.length; i++) {
    const msg = loaded[i];
    if (msg.role === "assistant" && msg.toolCalls) {
      const expectedIds = new Set(msg.toolCalls.map((c) => c.id));
      const foundIds = new Set(
        loaded
          .slice(i + 1)
          .filter((m) => m.role === "tool" && m.toolCallId && expectedIds.has(m.toolCallId))
          .map((m) => m.toolCallId!)
      );
      assert.equal(foundIds.size, expectedIds.size, `assistant turn's tool calls must ALL have their real results retained together (block ${i})`);
    }
  }
  console.log("    confirmed: every retained tool-call turn is fully intact, no partial blocks");

  console.log("\n[4] Repeated real saves (simulating many more turns) never reintroduce an orphan...\n");
  let running = loaded;
  for (let round = 0; round < 5; round++) {
    running = [...running, { role: "user", content: `Follow-up ${round}` }, { role: "assistant", content: `Real reply ${round}` }];
    saveConversationHistory(db, USER_ID, running);
    running = loadConversationHistory(db, USER_ID);
    assertNoOrphanedToolMessages(running);
  }
  console.log("    confirmed across 5 further real save/load rounds -- never orphaned");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
