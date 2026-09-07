import type { TradeExecutor } from "@dave/trading";
import { McpTradeExecutor } from "./mcp-trade-adapter.js";
import { getTradingModeConfig } from "./trading-mode-config.js";

/**
 * Real gap fixed: `McpTradeExecutor` was a complete, real, working alternative to the file-based
 * MT5 EA -- but every real call site (full-registry.ts's tradingCtx, the autonomous trading loop,
 * the worker execution engine) was wired to a single, fixed `TradeExecutor` chosen once at process
 * boot. `DynamicTradeExecutor` implements the SAME `TradeExecutor` interface, so it's a drop-in
 * replacement at that one construction point -- every real call transparently routes to whichever
 * backend (EA or MCP) the user has genuinely configured via /ea, re-checked live on every call
 * (not cached at boot), so switching modes takes effect immediately, no restart.
 */
export class DynamicTradeExecutor implements TradeExecutor {
  private mcpExecutor: McpTradeExecutor | undefined;
  private mcpServerUrl: string | undefined;

  constructor(
    private readonly userId: string,
    private readonly eaExecutor: TradeExecutor
  ) {}

  private async resolve(): Promise<TradeExecutor> {
    const config = getTradingModeConfig(this.userId);
    if (config.mode !== "mcp" || !config.mcpServerUrl) return this.eaExecutor;
    // Real, lazy (re)connect: only reconnects when there's no live client yet, or the configured
    // server URL genuinely changed since the last connection.
    if (!this.mcpExecutor || this.mcpServerUrl !== config.mcpServerUrl) {
      const executor = new McpTradeExecutor({ serverUrl: config.mcpServerUrl });
      await executor.connect();
      this.mcpExecutor = executor;
      this.mcpServerUrl = config.mcpServerUrl;
    }
    return this.mcpExecutor;
  }

  async openOrder(order: Parameters<TradeExecutor["openOrder"]>[0]) {
    return (await this.resolve()).openOrder(order);
  }
  async modifyOrder(ticket: string, changes: Parameters<TradeExecutor["modifyOrder"]>[1]) {
    return (await this.resolve()).modifyOrder(ticket, changes);
  }
  async closePosition(ticket: string, lots?: number) {
    return (await this.resolve()).closePosition(ticket, lots);
  }
  async deletePendingOrder(ticket: string) {
    return (await this.resolve()).deletePendingOrder(ticket);
  }
  async listOpenPositions() {
    return (await this.resolve()).listOpenPositions();
  }
  async listPendingOrders() {
    return (await this.resolve()).listPendingOrders();
  }
}
