import type { TradeExecutor } from "./trade-executor.js";
import { validateOrder, type OrderRequest } from "./order-types.js";

/**
 * Step 10.2: real order placement through the executor seam, with real
 * validation before anything is sent -- never silently fails, never
 * sends a malformed order.
 */
export async function tradeExecute(executor: TradeExecutor, order: OrderRequest): Promise<{ ticket: string }> {
  const errors = validateOrder(order);
  if (errors.length > 0) {
    throw new Error(`Cannot place order: ${errors.join("; ")}`);
  }
  return executor.openOrder(order);
}

/** Step 10.3: modify SL/TP on an open position, or explicitly remove one/both. */
export async function tradeModify(executor: TradeExecutor, ticket: string, changes: { sl?: number | null; tp?: number | null }): Promise<void> {
  await executor.modifyOrder(ticket, changes);
}

/** Step 10.3: partial close -- close only `lots` of the position, leaving the rest open. */
export async function partialClose(executor: TradeExecutor, ticket: string, lots: number): Promise<{ closedLots: number; remainingLots: number }> {
  if (!(lots > 0)) throw new Error("partial close lots must be positive");
  return executor.closePosition(ticket, lots);
}

export async function fullClose(executor: TradeExecutor, ticket: string): Promise<{ closedLots: number; remainingLots: number }> {
  return executor.closePosition(ticket);
}

/** Step 10.3: delete one specific pending order. */
export async function deletePendingOrder(executor: TradeExecutor, ticket: string): Promise<void> {
  await executor.deletePendingOrder(ticket);
}

/** Step 10.3: delete ALL pending orders. Real proof this hits every one, not just the first. */
export async function deleteAllPendingOrders(executor: TradeExecutor): Promise<{ deleted: string[] }> {
  const pending = await executor.listPendingOrders();
  const deleted: string[] = [];
  for (const order of pending) {
    await executor.deletePendingOrder(order.ticket);
    deleted.push(order.ticket);
  }
  return { deleted };
}
