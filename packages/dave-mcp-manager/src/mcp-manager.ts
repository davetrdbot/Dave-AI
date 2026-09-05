import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * Part 3 (B3): a REAL, generic MCP manager -- connect to ANY MCP server
 * (user- or Dave-supplied URL + optional bearer token), discover its
 * real tools, and call them by name. Separate from and in addition to
 * the Lovable-specific image-generation MCP connection, which stays
 * scoped to only that one server.
 *
 * Same real `@modelcontextprotocol/sdk` Client/StreamableHTTPClientTransport
 * this codebase already uses for MCP trade placement (mcp-trade-adapter.ts,
 * Step 11.3) -- that one is hardcoded to a fixed trading-tool contract on
 * one server; this one is generic: any server, any tools, discovered live.
 *
 * Connections are real live sockets, so (like EaTradeExecutor's pending
 * map) they're honestly in-memory only -- they do not survive a process
 * restart, and reconnecting after one requires calling mcpConnect again.
 */
export interface McpToolSummary {
  name: string;
  description?: string;
}

export interface McpConnection {
  id: string;
  serverUrl: string;
  connectedAt: number;
  tools: McpToolSummary[];
}

export class McpConnectionError extends Error {
  constructor(serverUrl: string, cause: unknown) {
    super(`Could not connect to MCP server at ${serverUrl}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "McpConnectionError";
  }
}

export class McpConnectionNotFoundError extends Error {
  constructor(id: string) {
    super(`No MCP connection "${id}" found -- call mcp_connect first.`);
    this.name = "McpConnectionNotFoundError";
  }
}

interface LiveConnection {
  client: Client;
  serverUrl: string;
  connectedAt: number;
  tools: McpToolSummary[];
}

const live = new Map<string, Map<string, LiveConnection>>(); // userId -> connectionId -> LiveConnection

function forUser(userId: string): Map<string, LiveConnection> {
  if (!live.has(userId)) live.set(userId, new Map());
  return live.get(userId)!;
}

/** Real connection attempt + real tool discovery via the server's own listTools(). */
export async function mcpConnect(userId: string, serverUrl: string, token?: string): Promise<McpConnection> {
  const client = new Client({ name: "dave-ai", version: "0.1.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : undefined);
  try {
    await client.connect(transport);
  } catch (err) {
    throw new McpConnectionError(serverUrl, err);
  }

  const discovered = await client.listTools();
  const tools: McpToolSummary[] = discovered.tools.map((t) => ({ name: t.name, description: t.description }));

  const id = randomBytes(6).toString("hex");
  const connectedAt = Date.now();
  forUser(userId).set(id, { client, serverUrl, connectedAt, tools });
  return { id, serverUrl, connectedAt, tools };
}

export function mcpList(userId: string): McpConnection[] {
  return [...forUser(userId).entries()].map(([id, conn]) => ({ id, serverUrl: conn.serverUrl, connectedAt: conn.connectedAt, tools: conn.tools }));
}

/** Real tool call against a real connected server -- same result-unwrapping the trade adapter uses. */
export async function mcpCall(userId: string, connectionId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const conn = forUser(userId).get(connectionId);
  if (!conn) throw new McpConnectionNotFoundError(connectionId);

  const result = await conn.client.callTool({ name: toolName, arguments: args });
  if (result.isError) {
    const text = Array.isArray(result.content) ? result.content.map((c: any) => c.text ?? "").join(" ") : String(result.content);
    throw new Error(`MCP tool "${toolName}" on ${conn.serverUrl} returned an error: ${text}`);
  }
  const first = Array.isArray(result.content) ? result.content[0] : undefined;
  if (first && "text" in first) {
    try {
      return JSON.parse((first as { text: string }).text);
    } catch {
      return first;
    }
  }
  return result;
}

export async function mcpDisconnect(userId: string, connectionId: string): Promise<{ disconnected: boolean }> {
  const conns = forUser(userId);
  const conn = conns.get(connectionId);
  if (!conn) return { disconnected: false };
  await conn.client.close();
  conns.delete(connectionId);
  return { disconnected: true };
}
