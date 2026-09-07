import { mcpConnect, mcpList, mcpCall, mcpDisconnect } from "./mcp-manager.js";
import { listMcpServerConfigs, getMcpServerConfig } from "./server-config.js";

export interface McpManagerToolContext {
  userId: string;
}

export interface McpManagerToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: McpManagerToolContext) => Promise<unknown>;
}

export const MCP_MANAGER_TOOLS: McpManagerToolDefinition[] = [
  {
    name: "mcp_connect",
    description: "Connect to ANY MCP server by URL (optionally with a bearer token) and discover its real tools -- generic, not scoped to any one server.",
    parameters: { type: "object", required: ["serverUrl"], properties: { serverUrl: { type: "string" }, token: { type: "string" } } },
    execute: async (args, ctx) => mcpConnect(ctx.userId, args.serverUrl as string, args.token as string | undefined),
  },
  {
    name: "mcp_list",
    description: "List every MCP server you're currently connected to, and the real tools each one exposed.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => mcpList(ctx.userId),
  },
  {
    name: "mcp_call",
    description: "Call a real tool on a connected MCP server by connection id + tool name.",
    parameters: {
      type: "object",
      required: ["connectionId", "toolName"],
      properties: { connectionId: { type: "string" }, toolName: { type: "string" }, args: { type: "object" } },
    },
    execute: async (args, ctx) => mcpCall(ctx.userId, args.connectionId as string, args.toolName as string, (args.args as Record<string, unknown>) ?? {}),
  },
  {
    name: "mcp_disconnect",
    description: "Disconnect from a connected MCP server by connection id.",
    parameters: { type: "object", required: ["connectionId"], properties: { connectionId: { type: "string" } } },
    execute: async (args, ctx) => mcpDisconnect(ctx.userId, args.connectionId as string),
  },
  {
    name: "mcp_list_saved_servers",
    description: "List the user's real saved MCP server configs (provisioned ahead of time in /settings) -- name, url, and whether a token is stored (never the token itself). Use this instead of asking the user for a URL when they refer to a server they've already set up.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => listMcpServerConfigs(ctx.userId).map((c) => ({ id: c.id, name: c.name, url: c.url, hasToken: Boolean(c.token) })),
  },
  {
    name: "mcp_connect_saved",
    description: "Connect to one of the user's saved MCP servers by id (from mcp_list_saved_servers) -- opens the same real live connection mcp_connect does, using the saved url/token.",
    parameters: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    execute: async (args, ctx) => {
      const config = getMcpServerConfig(ctx.userId, args.id as string);
      if (!config) throw new Error(`No saved MCP server "${args.id}" -- call mcp_list_saved_servers first.`);
      return mcpConnect(ctx.userId, config.url, config.token);
    },
  },
];
