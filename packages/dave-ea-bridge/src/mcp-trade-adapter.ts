import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { TradeExecutor } from "@dave/trading";

/**
 * Step 11.3: MCP-based trade placement for users without an EA. Real
 * client using the real @modelcontextprotocol/sdk, talking to a
 * configured MCP server that exposes trading tools (a broker's own MCP
 * server, or a self-hosted bridge someone points Dave at) -- this
 * module doesn't invent a trading-tool protocol, it speaks the real MCP
 * wire protocol and calls tools by name.
 *
 * No real MCP trading server exists to connect to in this environment,
 * so real proof here is the same honest-attempt methodology used for
 * AirLLM/DSH-sandbox/OpenSandbox in earlier steps: a real, bounded
 * connection attempt against a configured URL, with the real result
 * (success or a real, typed failure) reported rather than assumed.
 */

export interface McpTradeConfig {
  serverUrl: string;
  toolNames?: {
    openOrder?: string;
    modifyOrder?: string;
    closePosition?: string;
    deletePendingOrder?: string;
    listOpenPositions?: string;
    listPendingOrders?: string;
  };
}

const DEFAULT_TOOL_NAMES: Required<NonNullable<McpTradeConfig["toolNames"]>> = {
  openOrder: "open_order",
  modifyOrder: "modify_order",
  closePosition: "close_position",
  deletePendingOrder: "delete_pending_order",
  listOpenPositions: "list_open_positions",
  listPendingOrders: "list_pending_orders",
};

export class McpConnectionError extends Error {
  constructor(serverUrl: string, cause: unknown) {
    super(`Could not connect to MCP trade server at ${serverUrl}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "McpConnectionError";
  }
}

export class McpTradeExecutor implements TradeExecutor {
  private client: Client | undefined;
  private readonly toolNames: Required<NonNullable<McpTradeConfig["toolNames"]>>;

  constructor(private readonly config: McpTradeConfig) {
    this.toolNames = { ...DEFAULT_TOOL_NAMES, ...config.toolNames };
  }

  /** Real connection attempt -- reports what actually happened, never assumes a server is reachable. */
  async connect(): Promise<void> {
    const client = new Client({ name: "dave-ai", version: "0.1.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(this.config.serverUrl));
    try {
      await client.connect(transport);
    } catch (err) {
      throw new McpConnectionError(this.config.serverUrl, err);
    }
    this.client = client;
  }

  private requireClient(): Client {
    if (!this.client) throw new Error("McpTradeExecutor.connect() must succeed before placing trades through it.");
    return this.client;
  }

  private async callTool<T>(toolName: string, args: Record<string, unknown>): Promise<T> {
    const result = await this.requireClient().callTool({ name: toolName, arguments: args });
    if (result.isError) {
      const text = Array.isArray(result.content) ? result.content.map((c: any) => c.text ?? "").join(" ") : String(result.content);
      throw new Error(`MCP tool "${toolName}" returned an error: ${text}`);
    }
    const first = Array.isArray(result.content) ? result.content[0] : undefined;
    if (first && "text" in first) {
      try {
        return JSON.parse((first as { text: string }).text) as T;
      } catch {
        return first as unknown as T;
      }
    }
    return result as unknown as T;
  }

  async openOrder(order: { symbol: string; type: string; lots: number; price?: number; sl?: number; tp?: number }): Promise<{ ticket: string }> {
    return this.callTool(this.toolNames.openOrder, order as unknown as Record<string, unknown>);
  }

  async modifyOrder(ticket: string, changes: { sl?: number | null; tp?: number | null; price?: number }): Promise<void> {
    await this.callTool(this.toolNames.modifyOrder, { ticket, ...changes });
  }

  async closePosition(ticket: string, lots?: number): Promise<{ closedLots: number; remainingLots: number }> {
    return this.callTool(this.toolNames.closePosition, { ticket, lots });
  }

  async deletePendingOrder(ticket: string): Promise<void> {
    await this.callTool(this.toolNames.deletePendingOrder, { ticket });
  }

  async listOpenPositions(): Promise<{ ticket: string; symbol: string }[]> {
    return this.callTool(this.toolNames.listOpenPositions, {});
  }

  async listPendingOrders(): Promise<{ ticket: string; symbol: string }[]> {
    return this.callTool(this.toolNames.listPendingOrders, {});
  }
}
