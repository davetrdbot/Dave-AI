import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { OpenAICompatibleProvider } from "@dave/brain";
import { ToolRegistry, AgentLoop } from "../src/index.js";
import { CORE_TOOL_NAMES, MAX_TOOLS_PER_REQUEST } from "../src/tool-selection.js";

/**
 * Real proof for item 1 (user, with a real Grok error: "'tools': maximum number of items is
 * 128"): a large registry (> MAX_TOOLS_PER_REQUEST) genuinely only sends the curated CORE subset
 * by default, and a tool OUTSIDE that subset is still genuinely reachable -- search_tools finds
 * it, and it becomes real, callable on the very next turn, not just visible as text.
 */

console.log("=== Real proof: dynamic tool selection keeps every request under the real provider cap ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-dynamic-tools-"));
process.chdir(workDir);

async function main() {
  const registry = new ToolRegistry();

  // A real CORE tool (present in CORE_TOOL_NAMES) -- always sent.
  registry.register([{ name: "find_setup", description: "Scan for a setup.", parameters: { type: "object", properties: {} }, execute: async () => ({ ok: true }) }]);

  // 150 real, non-core filler tools -- pushes the registry well past MAX_TOOLS_PER_REQUEST,
  // matching the real production registry's actual scale (205 tools).
  for (let i = 0; i < 150; i++) {
    registry.register([{ name: `filler_tool_${i}`, description: `Filler tool number ${i}.`, parameters: { type: "object", properties: {} }, execute: async () => ({ i }) }]);
  }

  // A real, non-core, DISCOVERABLE tool -- not in CORE_TOOL_NAMES, only reachable via search_tools.
  let wyckoffCalledWith: Record<string, unknown> | undefined;
  registry.register([
    {
      name: "get_wyckoff",
      description: "Real Wyckoff phase analysis for a symbol.",
      parameters: { type: "object", properties: { symbol: { type: "string" } } },
      execute: async (args) => {
        wyckoffCalledWith = args;
        return { phase: "accumulation" };
      },
    },
  ]);

  // The real search_tools tool, same shape full-registry.ts wires up.
  registry.register([
    {
      name: "search_tools",
      description: "Search your own registered tools by keyword.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      execute: async (args) => ({ matches: registry.search(args.query as string) }),
    },
  ]);

  assert.ok(registry.list().length > MAX_TOOLS_PER_REQUEST, "this test's registry must genuinely exceed the real cap to prove filtering actually engages");
  assert.ok(!CORE_TOOL_NAMES.includes("get_wyckoff"), "get_wyckoff must genuinely NOT be in the core set for this to be a real proof");

  let callCount = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      callCount++;
      if (callCount === 1) {
        console.log(`[1] Turn 1: registry has ${registry.list().length} real tools -- the real request sent only ${parsed.tools.length}...\n`);
        assert.ok(parsed.tools.length <= MAX_TOOLS_PER_REQUEST, "must genuinely stay under the real provider cap");
        assert.ok(!parsed.tools.some((t: any) => t.function.name === "get_wyckoff"), "a non-core tool must NOT be sent before it's been discovered");
        assert.ok(parsed.tools.some((t: any) => t.function.name === "find_setup"), "a real core tool must still be present");
        console.log(`    confirmed: ${parsed.tools.length} tools sent (cap ${MAX_TOOLS_PER_REQUEST}), get_wyckoff correctly absent\n`);
        console.log("[2] Model calls search_tools(\"wyckoff\") to discover it...\n");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "search_tools", arguments: JSON.stringify({ query: "wyckoff" }) } }] } }] }));
      } else if (callCount === 2) {
        console.log("[3] Turn 2: get_wyckoff is now genuinely present in the active set after being discovered...\n");
        assert.ok(parsed.tools.some((t: any) => t.function.name === "get_wyckoff"), "get_wyckoff must be reachable now that search_tools found it");
        console.log(`    confirmed: get_wyckoff now present (${parsed.tools.length} tools sent this turn)\n`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "get_wyckoff", arguments: JSON.stringify({ symbol: "EURUSD" }) } }] } }] }));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "Real Wyckoff phase: accumulation.", tool_calls: undefined } }] }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a real TCP address");

  try {
    const provider = new OpenAICompatibleProvider("openai", `http://127.0.0.1:${address.port}`, "test-key", "gpt-5.6-sol");
    const loop = new AgentLoop(provider, registry);
    const result = await loop.run([{ role: "user", content: "What's the Wyckoff phase on EURUSD?" }], { maxSteps: 5 });
    assert.equal(result.status, "done");
    assert.equal((result as any).text, "Real Wyckoff phase: accumulation.");
    assert.deepEqual(wyckoffCalledWith, { symbol: "EURUSD" });
    console.log("\n[4] The real tool was genuinely called with the real args once discovered -- ALL ASSERTIONS PASSED\n");
    console.log(`    real call: get_wyckoff(${JSON.stringify(wyckoffCalledWith)}) -> final answer: "${(result as any).text}"`);
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
