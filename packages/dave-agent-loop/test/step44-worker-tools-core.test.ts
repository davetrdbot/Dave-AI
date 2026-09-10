import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { DaveDatabase } from "@dave/db";
import { EaTradeExecutor } from "@dave/ea-bridge";
import { OpenAICompatibleProvider } from "@dave/brain";
import { buildFullToolRegistry, AgentLoop } from "../src/index.js";
import { CORE_TOOL_NAMES, MAX_TOOLS_PER_REQUEST } from "../src/tool-selection.js";

/**
 * Real proof for item 7 (user: "a worker gets created with a name but never executes its
 * assigned task, never reports back... no working delete-worker tool despite this being
 * reported as done previously"). Direct re-investigation found the worker lifecycle tools
 * (create_subagent/list_subagents/retire_subagent) were ALWAYS real and working -- step72/step73
 * already prove a genuine multi-turn run, real reporting, and real retirement -- but NONE of
 * them were in CORE_TOOL_NAMES, the exact same "real but undiscoverable" gap items 1/4/11 had.
 * A model that never happens to call search_tools first would never reach retire_subagent when
 * a user asks it to delete a worker. This proves they're genuinely core now, AND that a real
 * end-to-end create -> retire round trip works through the CORE-limited path specifically (no
 * search_tools call at all), not just the full-registry path step32 already covers.
 */

console.log("=== Real proof: worker lifecycle tools are core-reachable, not discovery-only ===\n");

for (const name of ["create_subagent", "list_subagents", "retire_subagent"]) {
  assert.ok(CORE_TOOL_NAMES.includes(name), `CORE_TOOL_NAMES must genuinely include "${name}"`);
}
console.log(`    confirmed present in CORE_TOOL_NAMES: create_subagent, list_subagents, retire_subagent`);
assert.ok(CORE_TOOL_NAMES.length < MAX_TOOLS_PER_REQUEST);

const workDir = mkdtempSync(join(tmpdir(), "dave-worker-tools-core-"));
process.chdir(workDir);
const OWNER = "user-worker-core-1";

async function main() {
  const db = new DaveDatabase(join(workDir, "dave.db"));
  const executor = new EaTradeExecutor(OWNER);
  const registry = buildFullToolRegistry({ userId: OWNER, db, executor });

  assert.ok(registry.list().length > MAX_TOOLS_PER_REQUEST, "the real production registry must genuinely exceed the cap for this to be a real proof of core-reachability");

  let callCount = 0;
  let createdId: string | undefined;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      callCount++;
      if (callCount === 1) {
        console.log("[1] Turn 1: create_subagent is genuinely present in the CORE set -- no search_tools needed...\n");
        assert.ok(parsed.tools.some((t: any) => t.function.name === "create_subagent"), "create_subagent must be sent by default");
        console.log(`    confirmed present among ${parsed.tools.length} core tools sent this turn`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "create_subagent", arguments: JSON.stringify({ assignment: "temporary", role: "generic", task: "Scan EURUSD for a setup." }) } }] } }] }));
      } else if (callCount === 2) {
        const toolMsg = parsed.messages.find((m: any) => m.role === "tool");
        const created = JSON.parse(toolMsg.content);
        createdId = created.id;
        console.log(`\n[2] Real worker created: "${created.name}" (${created.id})\n`);
        console.log("[3] Turn 2: retire_subagent is ALSO genuinely present in the CORE set -- no search_tools needed...\n");
        assert.ok(parsed.tools.some((t: any) => t.function.name === "retire_subagent"), "retire_subagent must be sent by default");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "retire_subagent", arguments: JSON.stringify({ workerId: createdId }) } }] } }] }));
      } else {
        console.log("\n[4] The real delete/retire genuinely happened -- confirmed via list_subagents in the same real registry...\n");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "Worker retired." } }] }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  try {
    const provider = new OpenAICompatibleProvider("groq", `http://127.0.0.1:${port}`, "test-key", "llama-3.3-70b-versatile");
    const loop = new AgentLoop(provider, registry);
    const result = await loop.run([{ role: "user", content: "Create a worker to scan EURUSD, then delete it." }], { maxSteps: 6 });
    assert.equal(result.status, "done");
    assert.equal((result as any).text, "Worker retired.");

    const listed: any = await registry.execute("list_subagents", {});
    assert.ok(!listed.some((w: any) => w.id === createdId), "the real delete-worker tool must have genuinely removed it from the active list");
    console.log(`    confirmed: worker ${createdId} genuinely gone from list_subagents after retire_subagent -- real delete, not a stub`);
  } finally {
    server.close();
  }

  console.log("\n=== ALL ASSERTIONS PASSED ===");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(workDir, { recursive: true, force: true });
  });
