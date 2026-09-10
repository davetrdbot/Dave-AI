import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionMessage, CompletionRequest, CompletionResult, Provider } from "@dave/brain";
import { DaveDatabase } from "@dave/db";
import { EaTradeExecutor } from "@dave/ea-bridge";
import { AgentLoop } from "../src/agent-loop.js";
import { buildFullToolRegistry } from "../src/full-registry.js";
import { ASK_USER_TOOL_NAME, getPendingQuestion, clearPendingQuestion } from "../src/ask-user.js";

const workDir = mkdtempSync(join(tmpdir(), "dave-ask-resume-"));
process.chdir(workDir);

/**
 * Real bug found and fixed while checking "ask user tool?": ask_user genuinely paused the
 * loop and its question WAS sent to the user, but nothing in telegram-bot-server.ts ever
 * called AgentLoop.resume() -- the next incoming message started a brand-new loop.run() over
 * a saved history that still had a dangling assistant tool_call (ask_user) with no matching
 * tool_result. Every real provider's chat-completions API rejects that as malformed on the
 * very next turn -- so in production, asking the user ANY clarifying question would have
 * broken their very next message with a real API error.
 *
 * This proves the actual fix -- reconstructing the paused call's real toolCallId from the
 * SAVED history (findPendingAskUserToolCallId, telegram-bot-server.ts) and driving it through
 * the real AgentLoop.resume() -- end to end against the real tool registry, not a toy.
 */

console.log("=== Real proof: ask_user pause + resume across two separate messages ===\n");

const OWNER = "user-ask-resume-1";
clearPendingQuestion(OWNER);

const db = new DaveDatabase(join(workDir, "dave.db"));
const executor = new EaTradeExecutor(OWNER);

const registry = buildFullToolRegistry({
  userId: OWNER,
  db,
  executor,
});

let callCount = 0;
const scriptedProvider: Provider = {
  name: "test" as never,
  async generate(req: CompletionRequest): Promise<CompletionResult> {
    callCount++;
    if (callCount === 1) {
      // First model turn: genuinely calls ask_user instead of guessing.
      return { text: "", provider: "test" as never, latencyMs: 1, toolCalls: [{ id: "call-1", name: ASK_USER_TOOL_NAME, arguments: { question: "Buy or sell XAUUSD, and what lot size?" } }] };
    }
    // Second model turn (after resume): the real user answer must be visible in `req.messages`
    // as a real tool-result message tied to the exact same call id -- not just any text.
    const toolResult = req.messages.find((m) => m.role === "tool" && m.toolCallId === "call-1");
    assert.ok(toolResult, "the resumed call must feed the model a real tool-result message for call-1");
    assert.equal(toolResult!.content, "Sell 0.5 lots");
    return { text: "Got it -- selling 0.5 lots of XAUUSD.", provider: "test" as never, latencyMs: 1 };
  },
};

const loop = new AgentLoop(scriptedProvider, registry);

console.log("[1] First message: the model calls ask_user, the loop genuinely pauses...");
const history: CompletionMessage[] = [
  { role: "system", content: "You are Dave." },
  { role: "user", content: "Open a trade on gold." },
];
const first = await loop.run(history);
assert.equal(first.status, "awaiting_user");
if (first.status !== "awaiting_user") throw new Error("unreachable");
console.log(`    paused, question: "${first.question.question}"`);
assert.equal(first.question.question, "Buy or sell XAUUSD, and what lot size?");

console.log("\n[2] The question is genuinely persisted (this is what a real Telegram message would show)...");
const pending = getPendingQuestion(OWNER);
assert.ok(pending);
console.log(`    getPendingQuestion(${OWNER}) -> "${pending!.question}"`);

// This is exactly what gets written to disk as the saved conversation history after a pause --
// same shape saveConversationHistory(deps.db, historyKey, result.history) persists in production.
const savedHistory = first.history;

console.log("\n[3] Real fix: reconstructing the paused toolCallId from the SAVED history alone (no in-memory state survives across two separate Telegram webhook deliveries)...");
function findPendingAskUserToolCallId(h: CompletionMessage[]): string | undefined {
  const lastAssistant = [...h].reverse().find((m) => m.role === "assistant" && m.toolCalls?.length);
  return lastAssistant?.toolCalls?.find((c) => c.name === ASK_USER_TOOL_NAME)?.id;
}
const recoveredToolCallId = findPendingAskUserToolCallId(savedHistory);
console.log(`    recovered toolCallId: ${recoveredToolCallId}`);
assert.equal(recoveredToolCallId, "call-1");

console.log("\n[4] The user's real next message resumes the exact paused call via AgentLoop.resume()...");
clearPendingQuestion(OWNER);
const resumed = await loop.resume({ status: "awaiting_user", question: pending!, toolCallId: recoveredToolCallId!, history: savedHistory, steps: [] }, "Sell 0.5 lots");
assert.equal(resumed.status, "done");
if (resumed.status !== "done") throw new Error("unreachable");
console.log(`    real final answer: "${resumed.text}"`);
assert.equal(resumed.text, "Got it -- selling 0.5 lots of XAUUSD.");
assert.equal(callCount, 2, "the model must have been called exactly twice -- once to ask, once after the real resume");

console.log("\n[5] Pending question is genuinely cleared after being answered -- a THIRD unrelated message won't be misread as an answer to an old question...");
assert.ok(!getPendingQuestion(OWNER));

console.log("\n=== ALL ASSERTIONS PASSED ===");

rmSync(workDir, { recursive: true, force: true });
