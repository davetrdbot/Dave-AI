import { randomBytes } from "node:crypto";
import { enqueueRFeedCommand, type RFeedCommand, type HistoryCandle, type HistoryResult } from "./rfeed-webhook.js";

/**
 * R_Feed job 1: history download. Dave (or a worker) asks for real
 * candles -- symbol/timeframe/date range -- the R_Feed EA pulls them
 * via MT5's real `CopyRates()` (confirmed real 3-overload signature
 * and the real `MqlRates` field order via research) and reports them
 * back on its next report, same one-directional WebRequest round-trip
 * as every other R_Feed/Dave-EA command.
 */
export class HistoryRequestManager {
  private readonly pending = new Map<string, { resolve: (r: HistoryCandle[]) => void; reject: (err: Error) => void }>();

  constructor(
    private readonly userId: string,
    private readonly timeoutMs = 30_000
  ) {}

  resolveHistoryResult(result: HistoryResult): void {
    const waiter = this.pending.get(result.commandId);
    if (!waiter) return;
    this.pending.delete(result.commandId);
    if (result.status === "ok") waiter.resolve(result.candles ?? []);
    else waiter.reject(new Error(result.message ?? `R_Feed EA reported an error for history request ${result.commandId}`));
  }

  requestHistory(symbol: string, timeframe: string, startTime: Date, endTime: Date): Promise<HistoryCandle[]> {
    const command: RFeedCommand = {
      id: randomBytes(8).toString("hex"),
      action: "request_history",
      symbol,
      timeframe,
      startTime: Math.floor(startTime.getTime() / 1000),
      endTime: Math.floor(endTime.getTime() / 1000),
    };
    enqueueRFeedCommand(this.userId, command);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(command.id);
        reject(new Error(`R_Feed EA did not report history for request ${command.id} within ${this.timeoutMs}ms -- is it running and connected?`));
      }, this.timeoutMs);
      this.pending.set(command.id, {
        resolve: (candles) => {
          clearTimeout(timer);
          resolve(candles);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }
}
