import { randomBytes } from "node:crypto";
import type { TradeExecutor } from "@dave/trading";
import { enqueueCommand, getLastKnownState, type EaCommand, type EaCommandResult } from "./ea-webhook.js";

/**
 * Real implementation of dave-trading's TradeExecutor seam, backed by
 * the actual EA<->Dave contract. Honest about what that means: MT5's
 * WebRequest is one-directional, so a command placed here doesn't
 * execute the instant this function is called -- it's enqueued, the EA
 * picks it up on its next heartbeat (PushSeconds apart), executes it,
 * and reports the result on ITS next report after that. openOrder() and
 * friends return a promise that resolves once that real result comes
 * back (via resolveCommand(), wired to the webhook server's onReport
 * handler), not immediately -- with a timeout so a silent/offline EA
 * doesn't hang the caller forever.
 */
export class EaTradeExecutor implements TradeExecutor {
  private readonly pending = new Map<string, { command: EaCommand; resolve: (r: EaCommandResult) => void; reject: (err: Error) => void }>();

  // Real bug fixed (user: "increase the timeout... make sure they is nothing stopping the agent
  // to trade"). The EA only picks up a queued command on its next scheduled tick (PushSeconds
  // apart), executes it, and ships the RESULT on its NEXT report after that -- confirmed directly
  // in ea/DaveEA.mq5 (ExecuteCommandsFromResponse's own comment: "results only shipping on the
  // NEXT report"; PushReportAndExecuteCommands only ever runs from OnTimer, no immediate
  // follow-up POST after executing). With the EA's push interval now defaulting to 2 minutes
  // (user: "the ea tick should be sending every 2min"), the real worst-case round trip for a
  // single trade command is close to 2x that -- up to ~4 minutes -- while this timeout was still
  // the old 30 seconds. Every real trade attempt would time out before the EA got a genuine
  // chance to respond, which is exactly "it doesn't trade" with zero indication why. 5 minutes
  // gives real margin above that true worst case, not just a token bump.
  constructor(
    private readonly userId: string,
    private readonly timeoutMs = 300_000
  ) {}

  /**
   * Wired to the webhook server's onReport handler -- this is how a real
   * EA result reaches the waiting promise. Returns the ticket a
   * successfully-resolved "close" command was for, if any -- EaBridge
   * uses this to tell a Dave-initiated close apart from a real manual
   * close, without needing its own separate command-tracking map.
   */
  resolveCommand(result: EaCommandResult): { daveClosedTicket?: string; daveModifiedTicket?: string } {
    const waiter = this.pending.get(result.commandId);
    if (!waiter) return {}; // no one waiting (already timed out, or an unsolicited result) -- not an error
    this.pending.delete(result.commandId);
    if (result.status === "ok") {
      waiter.resolve(result);
      if (waiter.command.action === "close") return { daveClosedTicket: waiter.command.ticket };
      if (waiter.command.action === "modify") return { daveModifiedTicket: waiter.command.ticket };
      return {};
    }
    waiter.reject(new Error(result.message ?? `EA reported an error for command ${result.commandId}`));
    return {};
  }

  private awaitResult(command: EaCommand): Promise<EaCommandResult> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(command.id);
        reject(new Error(`EA did not report a result for command ${command.id} within ${this.timeoutMs}ms -- is the EA running and connected?`));
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

  async openOrder(order: { symbol: string; type: string; lots: number; price?: number; sl?: number; tp?: number }): Promise<{ ticket: string }> {
    const command: EaCommand = { id: this.newCommandId(), action: "open", symbol: order.symbol, type: order.type, lots: order.lots, price: order.price, sl: order.sl, tp: order.tp };
    enqueueCommand(this.userId, command);
    const result = await this.awaitResult(command);
    if (!result.ticket) throw new Error(`EA reported success for open command ${command.id} but returned no ticket`);
    return { ticket: result.ticket };
  }

  async modifyOrder(ticket: string, changes: { sl?: number | null; tp?: number | null; price?: number }): Promise<void> {
    const command: EaCommand = { id: this.newCommandId(), action: "modify", ticket, ...changes };
    enqueueCommand(this.userId, command);
    await this.awaitResult(command);
  }

  async closePosition(ticket: string, lots?: number): Promise<{ closedLots: number; remainingLots: number }> {
    const command: EaCommand = { id: this.newCommandId(), action: "close", ticket, lots };
    enqueueCommand(this.userId, command);
    await this.awaitResult(command);
    // remainingLots reflects the EA's next report, already applied to
    // last-known state by the time this promise resolves (the result
    // and the state update both arrive in the same EA report).
    const remaining = getLastKnownState(this.userId).positions.find((p) => p.ticket === ticket);
    return { closedLots: lots ?? 0, remainingLots: remaining?.lots ?? 0 };
  }

  async deletePendingOrder(ticket: string): Promise<void> {
    const command: EaCommand = { id: this.newCommandId(), action: "delete_pending", ticket };
    enqueueCommand(this.userId, command);
    await this.awaitResult(command);
  }

  /** Real, but eventually-consistent -- reflects the EA's most recent report, not a live query. */
  async listOpenPositions(): Promise<{ ticket: string; symbol: string }[]> {
    return getLastKnownState(this.userId).positions.map((p) => ({ ticket: p.ticket, symbol: p.symbol }));
  }

  async listPendingOrders(): Promise<{ ticket: string; symbol: string }[]> {
    return getLastKnownState(this.userId).pendingOrders.map((p) => ({ ticket: p.ticket, symbol: p.symbol }));
  }
}
