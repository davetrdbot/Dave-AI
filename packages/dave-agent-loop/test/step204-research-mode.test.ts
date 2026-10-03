import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "dave-research-"));
process.env.DAVE_DATA_ROOT = root;
process.env.DAVE_CREDENTIALS_KEY ??= "test-only-master-key-not-for-production";

/** Research mode: Dave can't stop after a couple of searches -- the turn is handed back to him,
 *  round after round, until he has read enough and declares it complete. */
const { AgentLoop } = await import("../src/agent-loop.js");
const { ToolRegistry } = await import("../src/tool-registry.js");
const bus = await import("../src/activity-bus.js");
const { runAppChatTurn, researchTopicOf } = await import("../src/app-chat.js");
const rm = await import("../src/research-mode.js");
const { DaveDatabase } = await import("@dave/db");

assert.equal(researchTopicOf({ text: "/research Runware API" }), "Runware API");
assert.equal(researchTopicOf({ text: "Runware API", research: true }), "Runware API");
assert.equal(researchTopicOf({ text: "hello" }), undefined);

const searches: string[] = [];
const registry = new ToolRegistry().register([
  { name: "web_search", description: "search", parameters: { type: "object" }, execute: async (a: Record<string, unknown>) => (searches.push(String(a.query)), { results: [] }) },
  { name: "scrape_url", description: "read", parameters: { type: "object" }, execute: async () => ({ markdown: "page" }) },
]);
// A lazy researcher: one search + one page, then tries to conclude every time.
let n = 0;
const seenPrompts: string[] = [];
const provider = {
  name: "fake",
  generate: async (req: { messages: { role: string; content: unknown }[] }) => {
    const last = req.messages.at(-1)!;
    if (last.role === "user") seenPrompts.push(String(typeof last.content === "string" ? last.content : JSON.stringify(last.content)));
    n++;
    if (last.role === "user") return { text: "", provider: "fake", latencyMs: 1, toolCalls: [{ id: `s${n}`, name: "web_search", arguments: { query: `q${n}` } }, { id: `r${n}`, name: "scrape_url", arguments: { url: "https://x" } }] };
    return { text: `Report so far. ${rm.RESEARCH_DONE_MARK}`, provider: "fake", latencyMs: 1 };
  },
} as never;

const db = new DaveDatabase(join(root, "dave.db"));
const deps = { userId: "owner", db, executor: {} as never, systemPrompt: "You are Dave." };
const before = bus.latestActivityId("owner");
const result = await runAppChatTurn(deps, { text: "Runware image API", research: true }, "t1", () => new AgentLoop(provider, registry));
assert.equal(result?.status, "done");
assert.match(seenPrompts[0], /\[RESEARCH MODE\]/, "the brief goes with the topic");
assert.match(seenPrompts[0], /ask_user with short options/, "permission questions go through ask_user");
// 2 sources per round; 12 needed -> 6 rounds even though it declared complete each time.
assert.equal(searches.length, 6, `kept researching (${searches.length} searches)`);
assert.match(seenPrompts[1], /RESEARCH ROUND 2 of 8/);
assert.match(seenPrompts[1], /too few sources/);
assert.match(seenPrompts[2], /don't repeat them\): "q1", "q3"/);
const notices = bus.activityAfter("owner", before).filter((e) => e.kind === "notice").map((e) => String(e.data.text));
assert.equal(notices.length, 5);
assert.match(notices[0], /Research round 2 of 8/);
assert.equal(rm.getActiveResearch("owner"), undefined, "finished research is cleared");

// Out of rounds: stops at maxRounds even if never declared complete.
const p = rm.startResearch("u2", "x");
for (let i = 0; i < 20; i++) if (!rm.researchContinuation(p, { status: "done", text: "not yet" })) break;
assert.equal(p.round, rm.DEFAULT_RESEARCH_DEPTH.maxRounds);

// A normal message is not research.
n = 0; searches.length = 0; seenPrompts.length = 0;
await runAppChatTurn(deps, { text: "hi" }, "t2", () => new AgentLoop(provider, registry));
assert.equal(searches.length, 1, "one round only outside research mode");
assert.doesNotMatch(seenPrompts[0], /RESEARCH MODE/);
console.log("=== ALL ASSERTIONS PASSED ===");
process.exit(0);
