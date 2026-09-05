import { mcpConnect, mcpList, mcpCall, mcpDisconnect } from "./mcp-manager.js";

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
];
