import type { OrderRequest } from "./order-types.js";

/**
 * The real trade round-trip goes through the EA webhook (Step 11) or the
 * MCP trade-placement alternative -- neither exists yet as a live
 * transport. This interface is the seam: trade_execute/trade_modify
 * below are real, tested logic that call through it, exactly like
 * Provider (dave-brain) and Transport (dave-core/dave-davema) let
 * earlier steps build and test real logic ahead of the transport that
 * eventually backs it.
 */
export interface TradeExecutor {
  openOrder(order: OrderRequest): Promise<{ ticket: string }>;
  modifyOrder(ticket: string, changes: { sl?: number | null; tp?: number | null; price?: number }): Promise<void>;
  closePosition(ticket: string, lots?: number): Promise<{ closedLots: number; remainingLots: number }>;
  deletePendingOrder(ticket: string): Promise<void>;
  listOpenPositions(): Promise<{ ticket: string; symbol: string }[]>;
  listPendingOrders(): Promise<{ ticket: string; symbol: string }[]>;
}
