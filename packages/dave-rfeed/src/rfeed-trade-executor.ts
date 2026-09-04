import { randomBytes } from "node:crypto";
import type { TradeExecutor } from "@dave/trading";
import { enqueueRFeedCommand, getLastKnownRFeedState, type RFeedCommand, type RFeedCommandResult } from "./rfeed-webhook.js";
import { isKnownCustomSymbol, CustomSymbolTradeRefusedError } from "./custom-symbol-safety.js";

/**
 * R_Feed's real trade executor -- implements the EXACT SAME
 * `TradeExecutor` seam (@dave/trading) the real Dave EA's own executor
 * does, so Step 10's real `tradeExecute`/`tradeModify`/`partialClose`/
 * `fullClose`/`deletePendingOrder`/`deleteAllPendingOrders` functions
 * work UNCHANGED against R_Feed -- this is what "same trade-execution
 * engine pattern" means literally, not just "similarly shaped."
 *
 * Two real things this executor adds beyond mirroring EaTradeExecutor:
 * (1) the custom-symbol refusal gate, checked BEFORE a command is ever
 * enqueued -- a real trade never reaches the EA if the symbol is known
 * custom; (2) the MT5 comment field is kept to the user's short ID
 * (~31 char real MT5 limit), never a crammed-in strategy name -- the
 * real note lives in the database, linked by the real ticket number
 * once it comes back.
 */
export class RFeedTradeExecutor implements TradeExecutor {
  private readonly pending = new Map<string, { command: RFeedCommand; resolve: (r: RFeedCommandResult) => void; reject: (err: Error) => void }>();

  constructor(
    private readonly userId: string,
    private readonly timeoutMs = 30_000
  ) {}

  resolveCommand(result: RFeedCommandResult): void {
    const waiter = this.pending.get(result.commandId);
    if (!waiter) return; // no one waiting -- already timed out, or unsolicited
    this.pending.delete(result.commandId);
    if (result.status === "ok") waiter.resolve(result);
    else waiter.reject(new Error(result.message ?? `R_Feed EA reported an error for command ${result.commandId}`));
  }

  private awaitResult(command: RFeedCommand): Promise<RFeedCommandResult> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(command.id);
        reject(new Error(`R_Feed EA did not report a result for command ${command.id} within ${this.timeoutMs}ms -- is the R_Feed EA running and connected?`));
      }, this.timeoutMs);
      this.pending.set(command.id, {
        command,
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  private newCommandId(): string {
    return randomBytes(8).toString("hex");
  }

  /** Real, short comment -- an MT5-length-safe user ID, never a strategy name. Truncated defensively even though callers should already pass a short ID. */
  private shortComment(): string {
    return this.userId.slice(0, 31);
  }

  async openOrder(order: { symbol: string; type: string; lots: number; price?: number; sl?: number; tp?: number }): Promise<{ ticket: string }> {
    if (isKnownCustomSymbol(this.userId, order.symbol)) throw new CustomSymbolTradeRefusedError(order.symbol);
    const command: RFeedCommand = {
      id: this.newCommandId(),
      action: "open",
      symbol: order.symbol,
      type: order.type,
      lots: order.lots,
      price: order.price,
      sl: order.sl,
      tp: order.tp,
      comment: this.shortComment(),
    };
    enqueueRFeedCommand(this.userId, command);
    const result = await this.awaitResult(command);
    if (!result.ticket) throw new Error(`R_Feed EA reported success for open command ${command.id} but returned no ticket`);
    return { ticket: result.ticket };
  }

  async modifyOrder(ticket: string, changes: { sl?: number | null; tp?: number | null; price?: number }): Promise<void> {
    const command: RFeedCommand = { id: this.newCommandId(), action: "modify", ticket, ...changes };
    enqueueRFeedCommand(this.userId, command);
    await this.awaitResult(command);
  }

  async closePosition(ticket: string, lots?: number): Promise<{ closedLots: number; remainingLots: number }> {
    const command: RFeedCommand = { id: this.newCommandId(), action: "close", ticket, lots };
    enqueueRFeedCommand(this.userId, command);
    await this.awaitResult(command);
    const remaining = getLastKnownRFeedState(this.userId).positions.find((p) => p.ticket === ticket);
    return { closedLots: lots ?? 0, remainingLots: remaining?.lots ?? 0 };
  }

  async deletePendingOrder(ticket: string): Promise<void> {
    const command: RFeedCommand = { id: this.newCommandId(), action: "delete_pending", ticket };
    enqueueRFeedCommand(this.userId, command);
    await this.awaitResult(command);
  }

  async listOpenPositions(): Promise<{ ticket: string; symbol: string }[]> {
    return getLastKnownRFeedState(this.userId).positions.map((p) => ({ ticket: p.ticket, symbol: p.symbol }));
  }

  async listPendingOrders(): Promise<{ ticket: string; symbol: string }[]> {
    return getLastKnownRFeedState(this.userId).pendingOrders.map((p) => ({ ticket: p.ticket, symbol: p.symbol }));
  }
}
