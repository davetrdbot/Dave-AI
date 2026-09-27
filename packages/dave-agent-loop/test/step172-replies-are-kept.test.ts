import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DAVE_DATA_ROOT = mkdtempSync(join(tmpdir(), "dave-replies-"));

/**
 * The trader: "our memory is stupid, it keeps repeating messages I sent earlier every time".
 * Dave's final reply was never saved into the conversation, so every past message looked
 * unanswered and got answered again on each new one.
 */
const { AgentLoop } = await import("../src/agent-loop.js");
const { ToolRegistry } = await import("../src/tool-registry.js");
const { DaveDatabase } = await import("@dave/db");
const { loadConversationHistory, saveConversationHistory, closeUnanswered, ANSWERED_EARLIER } = await import("../src/conversation-store.js");
const { historyForDisplay } = await import("../src/app-chat-routes.js");

console.log("=== Step 172: Dave's replies stay in the conversation ===\n");

console.log("[1] A finished turn keeps the reply");
const provider = { generate: async () => ({ text: "Gold is at 2651.", toolCalls: [] }) } as never;
const done = await new AgentLoop(provider, new ToolRegistry()).run([{ role: "system", content: "s" }, { role: "user", content: "price of gold?" }]);
assert.deepEqual(done.history.at(-1), { role: "assistant", content: "Gold is at 2651." });
console.log("   ✓\n");

console.log("[2] A stopped turn closes the message with a note");
const ctl = new AbortController();
ctl.abort();
const stopped = await new AgentLoop(provider, new ToolRegistry()).run([{ role: "system", content: "s" }, { role: "user", content: "buy gold" }], { signal: ctl.signal });
assert.equal(stopped.status, "aborted");
assert.equal(stopped.history.at(-1)?.role, "assistant");
console.log("   ✓\n");

console.log("[3] A conversation saved by the old code heals on load");
const db = new DaveDatabase(join(process.env.DAVE_DATA_ROOT!, "dave.db"));
saveConversationHistory(db, "k", [
  { role: "system", content: "s" },
  { role: "user", content: "old question 1" },
  { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "get_price", arguments: {} }] },
  { role: "tool", toolCallId: "c1", content: "2651" },
  { role: "user", content: "old question 2" },
  { role: "user", content: "old question 3" },
] as never);
const healed = loadConversationHistory(db, "k");
assert.deepEqual(healed.map((m) => m.role), ["system", "user", "assistant", "tool", "assistant", "user", "assistant", "user"]);
assert.equal(healed[4].content, ANSWERED_EARLIER);
assert.equal(closeUnanswered(healed).length, healed.length, "healing twice changes nothing");
assert.ok(!historyForDisplay(healed).some((i) => i.text.includes("Answered at the time")), "the stand-in never shows in the app");
console.log("   ✓\n");
console.log("[4] Memory saves itself after a turn -- no remember_* call needed");
const { autoSaveMemory } = await import("../src/memory-autosave.js");
const { readMemoryEntries, readLive } = await import("@dave/memory");
let asked = 0;
const reviewer = (answer: string) => ({ generate: async () => (asked++, { text: answer, toolCalls: [] }) }) as never;
const saved = await autoSaveMemory(
  reviewer('Sure: {"operations":[{"action":"add","target":"user","content":"They only trade Boom and Crash, 0.2 lots."}],"adaptability":["They want short answers."]}'),
  "trader",
  { userText: "from now on only trade boom and crash with 0.2 lots, and keep your answers short", replyText: "Got it." },
);
assert.deepEqual(saved, ["They only trade Boom and Crash, 0.2 lots.", "They want short answers."]);
assert.ok(readMemoryEntries("trader", "user").includes("They only trade Boom and Crash, 0.2 lots."));
assert.match(readLive("trader", "ADAPTABILITY.md"), /short answers/);
console.log("   ✓\n");

console.log("[5] Small talk, a turn that already saved, and junk answers change nothing");
const before = asked;
assert.deepEqual(await autoSaveMemory(reviewer("{}"), "trader", { userText: "ok thanks", replyText: "👍" }), []);
assert.deepEqual(await autoSaveMemory(reviewer("{}"), "trader", { userText: "remember I trade from Lagos", replyText: "Saved.", steps: [{ toolName: "remember_user_fact", arguments: {}, result: {}, isError: false }] as never }), []);
assert.equal(asked, before, "no model call for either");
assert.deepEqual(await autoSaveMemory(reviewer("I think nothing"), "trader", { userText: "what is the price of gold right now?", replyText: "2651" }), []);
assert.deepEqual(await autoSaveMemory({ generate: async () => { throw new Error("no key"); } } as never, "trader", { userText: "my broker is Deriv", replyText: "ok" }), [], "a failed review never throws");
console.log("   ✓\n");
console.log("All Step 172 checks passed.");
