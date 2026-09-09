import assert from "node:assert/strict";
import { createServer } from "node:http";
import { DeepSeekProvider, CohereProvider, BedrockProvider } from "../src/providers.js";

/**
 * Real bug fixed (user, live-diagnosed with real pasted keys: "I can use any fuckin provider
 * nothing works"): a background audit found DeepSeekProvider, CohereProvider, and BedrockProvider
 * were all "existing custom implementations" that predated the later tool-calling system (Update
 * 9) and were NEVER retrofitted -- each silently never sent `tools` at all, never translated a
 * real assistant `toolCalls` array or "tool" role message into that provider's real wire shape,
 * and never parsed tool_calls back out of the response. For an agentic trading bot whose entire
 * value is calling real tools (trade_execute, find_setup, settings, ...), this made all three
 * providers structurally unable to do anything beyond plain chat -- confirmed live for DeepSeek
 * (real captured request body had `hasTools: false` unconditionally) before this fix.
 *
 * Bedrock was the worst of the three: it sent a literal `role: "tool"` message, which is not a
 * valid Converse API role at all (only user/assistant are) -- a real tool-result turn would have
 * been rejected by the real API outright, not just silently ignored.
 */

console.log("=== Real proof: DeepSeek, Cohere, and Bedrock now genuinely support real tool-calling ===\n");

const realToolSpec = [{ name: "find_setup", description: "Scan for a real trade setup.", parameters: { type: "object", properties: {} } }];
const historyWithToolCall = [
  { role: "user" as const, content: "find me a setup" },
  { role: "assistant" as const, content: "", toolCalls: [{ id: "call_abc", name: "find_setup", arguments: {} }] },
  { role: "tool" as const, toolCallId: "call_abc", content: JSON.stringify({ rows: [] }) },
];

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

console.log("[1] DeepSeekProvider: real tools sent, real tool_calls/tool_call_id translation, model from config (not hardcoded)...\n");
await withServer(
  (body, res) => {
    assert.equal(body.model, "deepseek-reasoner", "must use the configured model, not the old hardcoded 'deepseek-chat'");
    assert.deepEqual(body.tools, [{ type: "function", function: { name: "find_setup", description: "Scan for a real trade setup.", parameters: { type: "object", properties: {} } } }]);
    assert.deepEqual(body.messages[1], { role: "assistant", content: null, tool_calls: [{ id: "call_abc", type: "function", function: { name: "find_setup", arguments: "{}" } }] });
    assert.deepEqual(body.messages[2], { role: "tool", tool_call_id: "call_abc", content: '{"rows":[]}' });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "No setup right now.", tool_calls: [{ id: "call_new", function: { name: "find_setup", arguments: "{}" } }] } }] }));
  },
  async (port) => {
    const provider = new DeepSeekProvider("test-key", `http://127.0.0.1:${port}`, "deepseek-reasoner");
    const result = await provider.generate({ messages: historyWithToolCall, tools: realToolSpec }, 5000);
    assert.equal(result.text, "No setup right now.");
    assert.deepEqual(result.toolCalls, [{ id: "call_new", name: "find_setup", arguments: {} }]);
    console.log(`    real request confirmed correct, real tool_calls parsed back: ${JSON.stringify(result.toolCalls)}`);
  }
);

console.log("\n[2] CohereProvider: real tools sent (OpenAI-identical shape, confirmed via Cohere's own v2 docs), real tool_calls parsed...\n");
await withServer(
  (body, res) => {
    assert.deepEqual(body.tools, [{ type: "function", function: { name: "find_setup", description: "Scan for a real trade setup.", parameters: { type: "object", properties: {} } } }]);
    assert.deepEqual(body.messages[1], { role: "assistant", content: null, tool_calls: [{ id: "call_abc", type: "function", function: { name: "find_setup", arguments: "{}" } }] });
    assert.deepEqual(body.messages[2], { role: "tool", tool_call_id: "call_abc", content: '{"rows":[]}' });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: { content: [{ text: "No setup right now." }], tool_calls: [{ id: "call_new", type: "function", function: { name: "find_setup", arguments: "{}" } }] } }));
  },
  async (port) => {
    const provider = new CohereProvider("test-key", "command-a", `http://127.0.0.1:${port}`);
    const result = await provider.generate({ messages: historyWithToolCall, tools: realToolSpec }, 5000);
    assert.equal(result.text, "No setup right now.");
    assert.deepEqual(result.toolCalls, [{ id: "call_new", name: "find_setup", arguments: {} }]);
    console.log(`    real request confirmed correct, real tool_calls parsed back: ${JSON.stringify(result.toolCalls)}`);
  }
);

console.log("\n[3] BedrockProvider: real toolConfig sent, real toolUse/toolResult blocks -- no more invalid 'role: tool'...\n");
await withServer(
  (body, res) => {
    assert.deepEqual(body.toolConfig, { tools: [{ toolSpec: { name: "find_setup", description: "Scan for a real trade setup.", inputSchema: { json: { type: "object", properties: {} } } } }] });
    const toolResultMsg = body.messages[2];
    assert.equal(toolResultMsg.role, "user", "a tool result must be a real 'user' turn -- 'tool' is not a valid Converse role");
    assert.equal(toolResultMsg.content[0].toolResult.toolUseId, "call_abc");
    assert.deepEqual(toolResultMsg.content[0].toolResult.content, [{ text: '{"rows":[]}' }]);
    assert.equal(toolResultMsg.content[0].toolResult.status, "success");
    const assistantMsg = body.messages[1];
    assert.equal(assistantMsg.role, "assistant");
    assert.deepEqual(assistantMsg.content.find((b: any) => b.toolUse)?.toolUse, { toolUseId: "call_abc", name: "find_setup", input: {} });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ output: { message: { content: [{ text: "No setup right now." }, { toolUse: { toolUseId: "call_new", name: "find_setup", input: {} } }] } } }));
  },
  async (port) => {
    const provider = new BedrockProvider("AKIAFAKEKEY", "fakeSecret", "us-east-1", "anthropic.claude-sonnet-5", `http://127.0.0.1:${port}`);
    const result = await provider.generate({ messages: historyWithToolCall, tools: realToolSpec }, 5000);
    assert.equal(result.text, "No setup right now.");
    assert.deepEqual(result.toolCalls, [{ id: "call_new", name: "find_setup", arguments: {} }]);
    console.log(`    real request confirmed correct (valid 'user' role for tool results), real tool_calls parsed back: ${JSON.stringify(result.toolCalls)}`);
  }
);

console.log("\n=== ALL ASSERTIONS PASSED ===");
process.exit(0);
