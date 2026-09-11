import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ClaudeProvider, DeepSeekProvider, CohereProvider, BedrockProvider, OpenAICompatibleProvider } from "../src/providers.js";

/**
 * Real proof for a gap the user directly doubted was fixed ("I don't think you implemented the
 * bot tool to approve a trade to choose... well"): `tools` alone never stops a model from just
 * answering in plain text instead of calling the one tool it was offered -- for
 * autonomous-tick.ts's single mandatory trading-decision call, that would mean the model can
 * silently skip deciding at all, every cycle, with no trade ever firing and no error either.
 * `toolChoice` (providers.ts) forces the specific named tool, translated into each real
 * provider's own forced-tool-choice wire shape -- proven here against the real request body each
 * provider actually sends, not just that a decision parses afterward.
 */

console.log("=== Real proof: toolChoice forces the real decision tool across every provider ===\n");

const tool = [{ name: "submit_trading_decision", description: "Submit your real trading decision.", parameters: { type: "object", properties: { action: { type: "string" } } } }];
const messages = [{ role: "user" as const, content: "decide" }];

async function withServer<T>(handler: (body: any, res: any) => void, run: (port: number) => Promise<T>): Promise<T> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => handler(JSON.parse(raw), res));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    return await run(port);
  } finally {
    server.close();
  }
}

console.log("[1] ClaudeProvider: real tool_choice: {type:'tool', name} sent...\n");
await withServer(
  (body, res) => {
    assert.deepEqual(body.tool_choice, { type: "tool", name: "submit_trading_decision" });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ content: [{ type: "tool_use", id: "t1", name: "submit_trading_decision", input: { action: "SKIP" } }] }));
  },
  async (port) => {
    const provider = new ClaudeProvider("test-key", "claude-sonnet-5", `http://127.0.0.1:${port}`);
    const result = await provider.generate({ messages, tools: tool, toolChoice: { name: "submit_trading_decision" } }, 5000);
    assert.deepEqual(result.toolCalls, [{ id: "t1", name: "submit_trading_decision", arguments: { action: "SKIP" } }]);
    console.log(`    real tool_choice sent and honored: ${JSON.stringify(result.toolCalls)}`);
  }
);

console.log("\n[2] OpenAICompatibleProvider: real tool_choice: {type:'function', function:{name}} sent...\n");
await withServer(
  (body, res) => {
    assert.deepEqual(body.tool_choice, { type: "function", function: { name: "submit_trading_decision" } });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "t1", function: { name: "submit_trading_decision", arguments: '{"action":"SKIP"}' } }] } }] }));
  },
  async (port) => {
    const provider = new OpenAICompatibleProvider("openai", `http://127.0.0.1:${port}`, "test-key", "gpt-5");
    const result = await provider.generate({ messages, tools: tool, toolChoice: { name: "submit_trading_decision" } }, 5000);
    assert.deepEqual(result.toolCalls, [{ id: "t1", name: "submit_trading_decision", arguments: { action: "SKIP" } }]);
    console.log(`    real tool_choice sent and honored`);
  }
);

console.log("\n[3] DeepSeekProvider: real tool_choice sent (same OpenAI-shaped wire format)...\n");
await withServer(
  (body, res) => {
    assert.deepEqual(body.tool_choice, { type: "function", function: { name: "submit_trading_decision" } });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "t1", function: { name: "submit_trading_decision", arguments: "{}" } }] } }] }));
  },
  async (port) => {
    const provider = new DeepSeekProvider("test-key", `http://127.0.0.1:${port}`);
    const result = await provider.generate({ messages, tools: tool, toolChoice: { name: "submit_trading_decision" } }, 5000);
    assert.deepEqual(result.toolCalls, [{ id: "t1", name: "submit_trading_decision", arguments: {} }]);
    console.log(`    real tool_choice sent and honored`);
  }
);

console.log("\n[4] CohereProvider: real tool_choice sent (same OpenAI-shaped wire format)...\n");
await withServer(
  (body, res) => {
    assert.deepEqual(body.tool_choice, { type: "function", function: { name: "submit_trading_decision" } });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: { content: [{ text: "" }], tool_calls: [{ id: "t1", function: { name: "submit_trading_decision", arguments: "{}" } }] } }));
  },
  async (port) => {
    const provider = new CohereProvider("test-key", "command-a", `http://127.0.0.1:${port}`);
    const result = await provider.generate({ messages, tools: tool, toolChoice: { name: "submit_trading_decision" } }, 5000);
    assert.deepEqual(result.toolCalls, [{ id: "t1", name: "submit_trading_decision", arguments: {} }]);
    console.log(`    real tool_choice sent and honored`);
  }
);

console.log("\n[5] BedrockProvider: real toolConfig.toolChoice: {tool:{name}} sent...\n");
await withServer(
  (body, res) => {
    assert.deepEqual(body.toolConfig.toolChoice, { tool: { name: "submit_trading_decision" } });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ output: { message: { content: [{ toolUse: { toolUseId: "t1", name: "submit_trading_decision", input: {} } }] } } }));
  },
  async (port) => {
    const provider = new BedrockProvider("AKIAFAKEKEY", "fakeSecret", "us-east-1", "anthropic.claude-sonnet-5", `http://127.0.0.1:${port}`);
    const result = await provider.generate({ messages, tools: tool, toolChoice: { name: "submit_trading_decision" } }, 5000);
    assert.deepEqual(result.toolCalls, [{ id: "t1", name: "submit_trading_decision", arguments: {} }]);
    console.log(`    real tool_choice sent and honored`);
  }
);

console.log("\n[6] Without toolChoice, no forced choice is sent (existing agentic-loop callers unaffected)...\n");
await withServer(
  (body, res) => {
    assert.equal(body.tool_choice, undefined, "omitting toolChoice must not force anything -- normal optional tool use for every other caller");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ content: [{ type: "text", text: "just chatting" }] }));
  },
  async (port) => {
    const provider = new ClaudeProvider("test-key", "claude-sonnet-5", `http://127.0.0.1:${port}`);
    const result = await provider.generate({ messages, tools: tool }, 5000);
    assert.equal(result.text, "just chatting");
    console.log(`    real: no tool_choice sent, model answered in plain text as normal`);
  }
);

console.log("\n=== ALL ASSERTIONS PASSED ===");
process.exit(0);
