import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.DAVE_DATA_ROOT = mkdtempSync(join(tmpdir(), "coder-"));
process.env.DAVE_CREDENTIALS_KEY ??= "test-only-master-key-not-for-production";

/** The trader's coding agent: its own tools and workspace, keeps going round after round until
 *  it says TASK COMPLETE, a plain tools-only system prompt. */
const { AgentLoop } = await import("../src/agent-loop.js");
const c = await import("../src/coding-agent.js");
const { DaveDatabase } = await import("@dave/db");
const db = new DaveDatabase(join(process.env.DAVE_DATA_ROOT!, "dave.db"));

const prompt = c.coderSystemPrompt();
assert.match(prompt, /run: executes code in an E2B cloud sandbox/);
assert.match(prompt, /web_search/);
assert.doesNotMatch(prompt, /safety|refuse|harmful|trading/i, "tools only -- no safety prompt, nothing about trading");

// A model that writes a file in round 1, edits it in round 2, declares done in round 3.
let round = 0;
const seenSystem: string[] = [];
const provider = {
  name: "fake",
  generate: async (req: { messages: { role: string; content: unknown }[]; tools?: { name: string }[] }) => {
    seenSystem.push(String(req.messages[0].content));
    const toolNames = (req.tools ?? []).map((t) => t.name).sort();
    assert.deepEqual(toolNames, ["delete_file", "edit_file", "list_files", "read_file", "run", "scrape_url", "web_search", "write_file"], "exactly its own tools");
    const last = req.messages.at(-1)!;
    if (last.role === "user") {
      round++;
      if (round === 1) return { text: "", provider: "fake", latencyMs: 1, toolCalls: [{ id: "w", name: "write_file", arguments: { path: "app/main.py", content: "print('hi')\n" } }] };
      if (round === 2) return { text: "", provider: "fake", latencyMs: 1, toolCalls: [{ id: "e", name: "edit_file", arguments: { path: "app/main.py", old: "hi", new: "hello" } }] };
      return { text: `All done. ${c.CODER_DONE_MARK}`, provider: "fake", latencyMs: 1 };
    }
    return { text: "working on it", provider: "fake", latencyMs: 1 };
  },
} as never;

const r = await c.runCoderTask(db, "me", "write a hello script", (_p, reg) => new AgentLoop(provider, reg));
assert.deepEqual([r.rounds, r.done], [3, true], "it kept going until it said it was done");
assert.equal(c.readWorkspaceFile("me", "app/main.py").toString(), "print('hello')\n", "the workspace keeps its files");
assert.deepEqual(c.listWorkspace("me").map((f) => f.path), ["app/main.py"]);
assert.throws(() => c.readWorkspaceFile("me", "../../etc/passwd"), /outside the workspace/);
const log = c.readCoderLog("me");
assert.ok(log.some((e) => e.kind === "user" && e.text === "write a hello script"));
assert.ok(log.some((e) => e.kind === "notice" && /Round 2/.test(e.text ?? "")), "each new round is shown");
assert.ok(log.some((e) => e.kind === "final" && /All done/.test(e.text ?? "")));
assert.equal(c.isCoderRunning("me"), false);

// The round limit stops a task that never finishes.
c.setCoderSettings("me", { maxRounds: 2 });
const never = { name: "fake", generate: async () => ({ text: "still going", provider: "fake", latencyMs: 1 }) } as never;
const r2 = await c.runCoderTask(db, "me", "endless", (_p, reg) => new AgentLoop(never, reg));
assert.deepEqual([r2.rounds, r2.done], [2, false]);

// Settings: provider/model override, loop on and off.
const s = c.setCoderSettings("me", { provider: "infron" as never, model: "z-ai/glm-5.1", loop: { task: "check the site", everyMinutes: 30, nextAt: 1 } });
assert.deepEqual([s.provider, s.model, s.loop?.everyMinutes], ["infron", "z-ai/glm-5.1", 30]);
const off = c.setCoderSettings("me", { provider: null as never, model: null as never, loop: null as never });
assert.deepEqual([off.provider, off.model, off.loop], [undefined, undefined, undefined]);
// The sandbox round trip: packed in, unpacked back -- node_modules never carried.
const { writeFileSync, mkdirSync } = await import("node:fs");
mkdirSync(join(c.workspaceDir("me"), "node_modules/x"), { recursive: true });
writeFileSync(join(c.workspaceDir("me"), "node_modules/x/big.js"), "x");
const packed = c.packWorkspace("me");
writeFileSync(join(c.workspaceDir("me"), "scratch.txt"), "gone after unpack");
c.unpackWorkspace("me", packed);
assert.deepEqual(c.listWorkspace("me").map((f) => f.path).sort(), ["app/main.py"], "what the sandbox ended with is what's kept");
console.log("=== ALL ASSERTIONS PASSED ===");
process.exit(0);
