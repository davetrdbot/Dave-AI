import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpConnect, mcpList, mcpCall, mcpDisconnect, MCP_MANAGER_TOOLS } from "../src/index.js";

console.log("=== Part 3 (B3) real proof: generic MCP manager against a REAL live MCP server ===\n");

/** Spins up a REAL, independent MCP server (not a mock of our own manager) exposing one real tool. */
async function startRealWeatherServer(): Promise<{ serverUrl: string; httpServer: Server; mcpServer: McpServer; getEchoedToken: () => string | undefined }> {
  const mcpServer = new McpServer({ name: "test-weather-server", version: "1.0.0" });
  let echoedToken: string | undefined;
  mcpServer.registerTool(
    "get_weather",
    { description: "Real test tool -- returns a fixed weather report for a city.", inputSchema: { city: z.string() } },
    async ({ city }: { city: string }) => ({ content: [{ type: "text", text: JSON.stringify({ city, tempC: 21, condition: "clear" }) }] })
  );

  // Real SDK constraint: stateless mode (sessionIdGenerator: undefined) requires a
  // brand-new transport per HTTP request -- reusing one across the initialize +
  // follow-up requests throws "Stateless transport cannot be reused across
  // requests." Session-based (stateful) mode is what a real, single long-lived
  // MCP server actually runs -- and a given transport instance only accepts ONE
  // real initialize handshake in its lifetime, hence a fresh server per section below.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await mcpServer.connect(transport);

  const httpServer = createServer((req, res) => {
    echoedToken = req.headers["authorization"];
    transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("expected a real TCP address");
  return { serverUrl: `http://127.0.0.1:${address.port}/mcp`, httpServer, mcpServer, getEchoedToken: () => echoedToken };
}

async function main() {
  const OWNER = "user-mcp-1";
  const first = await startRealWeatherServer();
  try {
    console.log("[1] mcp_connect against a REAL live MCP server (real HTTP, real handshake)...");
    const conn = await mcpConnect(OWNER, first.serverUrl, "test-bearer-token");
    assert.ok(conn.id);
    assert.equal(conn.serverUrl, first.serverUrl);
    assert.deepEqual(conn.tools.map((t) => t.name), ["get_weather"]);
    assert.equal(first.getEchoedToken(), "Bearer test-bearer-token", "the bearer token must genuinely reach the server, not just be accepted client-side");
    console.log(`    real connection ${conn.id}, real discovered tool(s): ${conn.tools.map((t) => t.name).join(", ")}, real Authorization header seen server-side: "${first.getEchoedToken()}"`);

    console.log("\n[2] mcp_list shows the real live connection...");
    const listed = mcpList(OWNER);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, conn.id);
    console.log(`    ${listed.length} real connection(s) listed`);

    console.log("\n[3] mcp_call genuinely invokes the real tool on the real server...");
    const result: any = await mcpCall(OWNER, conn.id, "get_weather", { city: "Lagos" });
    assert.equal(result.city, "Lagos");
    assert.equal(result.tempC, 21);
    console.log(`    real tool result: ${JSON.stringify(result)}`);

    console.log("\n[4] mcp_disconnect genuinely closes the connection -- it's gone from mcp_list after...");
    const disc = await mcpDisconnect(OWNER, conn.id);
    assert.equal(disc.disconnected, true);
    assert.equal(mcpList(OWNER).length, 0);
    console.log("    confirmed: disconnected, no longer listed");
  } finally {
    first.httpServer.close();
    await first.mcpServer.close();
  }

  console.log("\n[5] Same real flow, but through the actual agent-callable tool manifest (not the raw functions), against a second independent real server...");
  const second = await startRealWeatherServer();
  try {
    const ctx = { userId: OWNER };
    const connectTool = MCP_MANAGER_TOOLS.find((t) => t.name === "mcp_connect")!;
    const listTool = MCP_MANAGER_TOOLS.find((t) => t.name === "mcp_list")!;
    const callTool = MCP_MANAGER_TOOLS.find((t) => t.name === "mcp_call")!;
    const disconnectTool = MCP_MANAGER_TOOLS.find((t) => t.name === "mcp_disconnect")!;

    const conn2: any = await connectTool.execute({ serverUrl: second.serverUrl, token: "test-bearer-token" }, ctx);
    const listed2: any = await listTool.execute({}, ctx);
    assert.equal(listed2.length, 1);
    const called: any = await callTool.execute({ connectionId: conn2.id, toolName: "get_weather", args: { city: "Accra" } }, ctx);
    assert.equal(called.city, "Accra");
    await disconnectTool.execute({ connectionId: conn2.id }, ctx);
    assert.equal((await listTool.execute({}, ctx) as any[]).length, 0);
    console.log(`    real tool-manifest round trip: connected -> called get_weather("Accra") -> ${JSON.stringify(called)} -> disconnected`);

    console.log("\n=== ALL ASSERTIONS PASSED ===");
  } finally {
    second.httpServer.close();
    await second.mcpServer.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
