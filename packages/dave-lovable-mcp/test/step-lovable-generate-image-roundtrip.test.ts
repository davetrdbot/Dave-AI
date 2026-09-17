import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { DaveDatabase } from "@dave/db";
import { LovableMcpImageClient, LOVABLE_TOOLS, setLovableMcpSettings } from "../src/index.js";

/**
 * Explicit reversal (the trader, live: "the mcp it expose a ai inside of it"): the real server's
 * `lovable_ai_agent` text tool, previously architecturally unreachable by this client, is now
 * real and callable via callAiAgent()/the lovable_ai_agent agent tool. Section [3]/[4] below prove
 * that round trip the same way [1]/[2] already prove generate_image's.
 */

/**
 * Settings audit item 4: the existing step26 test only proves the wire protocol against a
 * REAL (but rejecting, invalid-token) external server -- it never proves a genuinely
 * SUCCESSFUL round trip (a real `generate_image` MCP call returning a real image URL) because
 * that would require a live, working, real Lovable credential this repo doesn't have and must
 * not hardcode. This test closes that gap the right way: a real, local, in-process MCP server
 * (same @modelcontextprotocol/sdk McpServer + StreamableHTTPServerTransport pattern
 * dave-mcp-manager's own step37 test uses against a real external server) standing in for the
 * user's Lovable MCP server, so the full real MCP protocol exchange -- real HTTP, real JSON-RPC
 * handshake, real tools/call, real Authorization header -- is exercised end to end, with a
 * SUCCESSFUL result this time, entirely offline (no external network call).
 */
console.log("=== generate_image real MCP round trip (mocked server) ===\n");

async function startFakeLovableServer(): Promise<{ serverUrl: string; httpServer: Server; mcpServer: McpServer; getEchoedToken: () => string | undefined; getLastPrompt: () => string | undefined }> {
  const mcpServer = new McpServer({ name: "fake-lovable-mcp", version: "1.0.0" });
  let lastPrompt: string | undefined;
  // Mirrors the real server's confirmed three-tool surface (lovable_ai_agent/generate_image/
  // generate_voice) -- generate_voice is still deliberately never reachable by this client
  // (dave-notifications already has its own real TTS path), but generate_image and
  // lovable_ai_agent both are now, so both are registered here to prove the real call/response
  // shape this client actually parses for each.
  mcpServer.registerTool(
    "generate_image",
    {
      description: "Fake stand-in for the real Lovable MCP image-generation tool.",
      inputSchema: { prompt: z.string(), size: z.string().optional(), style: z.string().optional(), transparent_background: z.boolean().optional() },
    },
    async ({ prompt }: { prompt: string }) => {
      lastPrompt = prompt;
      return { content: [{ type: "text", text: `Generated image: https://fake-lovable-cdn.test/images/${encodeURIComponent(prompt)}.png` }] };
    }
  );
  mcpServer.registerTool(
    "lovable_ai_agent",
    {
      description: "Fake stand-in for the real Lovable MCP text-AI tool.",
      inputSchema: { prompt: z.string() },
    },
    async ({ prompt }: { prompt: string }) => {
      lastPrompt = prompt;
      return { content: [{ type: "text", text: `Lovable AI says: real answer to "${prompt}"` }] };
    }
  );

  let echoedToken: string | undefined;
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await mcpServer.connect(transport);
  const httpServer = createServer((req, res) => {
    echoedToken = req.headers["authorization"];
    transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("expected a real TCP address");
  return {
    serverUrl: `http://127.0.0.1:${address.port}/mcp`,
    httpServer,
    mcpServer,
    getEchoedToken: () => echoedToken,
    getLastPrompt: () => lastPrompt,
  };
}

async function main() {
  const workDir = mkdtempSync(join(tmpdir(), "dave-lovable-roundtrip-"));
  const first = await startFakeLovableServer();
  try {
    console.log("[1] LovableMcpImageClient.generateImage() against the real local MCP server -- real connect + real tools/call...");
    const client = new LovableMcpImageClient(first.serverUrl, "real-test-bearer-token");
    await client.connect();
    const result = await client.generateImage({ prompt: "a red circle" });
    assert.equal(result.url, "https://fake-lovable-cdn.test/images/a%20red%20circle.png");
    assert.match(result.raw, /^Generated image: https:\/\//);
    assert.equal(first.getEchoedToken(), "Bearer real-test-bearer-token", "the configured token must genuinely reach the server over the real MCP transport");
    assert.equal(first.getLastPrompt(), "a red circle", "the real prompt must genuinely reach the server's tool handler");
    console.log(`    real round trip succeeded: ${JSON.stringify(result)}`);
    console.log(`    real Authorization header seen server-side: "${first.getEchoedToken()}"`);
  } finally {
    first.httpServer.close();
    await first.mcpServer.close();
  }

  // Real SDK constraint (same as dave-mcp-manager's step37 test): a stateful transport only
  // accepts ONE real initialize handshake in its lifetime -- a fresh server for section 2.
  const second = await startFakeLovableServer();
  try {
    console.log("\n[2] Same real round trip through the agent-callable generate_image tool end to end (DB-backed settings -> real MCP call -> real result)...");
    const db = new DaveDatabase(join(workDir, "dave.db"));
    const OWNER = "roundtrip-user";
    setLovableMcpSettings(db, OWNER, { url: second.serverUrl, token: "second-real-token" });
    const tool = LOVABLE_TOOLS.find((t) => t.name === "generate_image")!;
    const toolResult: any = await tool.execute({ prompt: "a blue square" }, { userId: OWNER, db });
    assert.equal(toolResult.url, "https://fake-lovable-cdn.test/images/a%20blue%20square.png");
    assert.equal(second.getEchoedToken(), "Bearer second-real-token");
    assert.equal(second.getLastPrompt(), "a blue square");
    console.log(`    real tool-level round trip succeeded: ${JSON.stringify(toolResult)}`);
    db.close();
  } finally {
    second.httpServer.close();
    await second.mcpServer.close();
  }

  const third = await startFakeLovableServer();
  try {
    console.log("\n[3] LovableMcpImageClient.callAiAgent() against the real local MCP server -- real connect + real tools/call...");
    const client = new LovableMcpImageClient(third.serverUrl, "third-real-token");
    await client.connect();
    const response = await client.callAiAgent("what's the outlook for gold today?");
    assert.equal(response, 'Lovable AI says: real answer to "what\'s the outlook for gold today?"');
    assert.equal(third.getEchoedToken(), "Bearer third-real-token", "the configured token must genuinely reach the server over the real MCP transport");
    assert.equal(third.getLastPrompt(), "what's the outlook for gold today?", "the real prompt must genuinely reach the server's tool handler");
    console.log(`    real round trip succeeded: "${response}"`);
  } finally {
    third.httpServer.close();
    await third.mcpServer.close();
  }

  const fourth = await startFakeLovableServer();
  try {
    console.log("\n[4] Same real round trip through the agent-callable lovable_ai_agent tool end to end (DB-backed settings -> real MCP call -> real result)...");
    const db = new DaveDatabase(join(workDir, "dave2.db"));
    const OWNER = "roundtrip-user-2";
    setLovableMcpSettings(db, OWNER, { url: fourth.serverUrl, token: "fourth-real-token" });
    const tool = LOVABLE_TOOLS.find((t) => t.name === "lovable_ai_agent")!;
    const toolResult: any = await tool.execute({ prompt: "summarize EURUSD" }, { userId: OWNER, db });
    assert.equal(toolResult.response, 'Lovable AI says: real answer to "summarize EURUSD"');
    assert.equal(fourth.getEchoedToken(), "Bearer fourth-real-token");
    assert.equal(fourth.getLastPrompt(), "summarize EURUSD");
    console.log(`    real tool-level round trip succeeded: ${JSON.stringify(toolResult)}`);
    db.close();

    console.log("\n=== ALL ASSERTIONS PASSED ===");
  } finally {
    fourth.httpServer.close();
    await fourth.mcpServer.close();
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
