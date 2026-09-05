import { createRFeedWebhookServer, type RFeedReport, type RFeedClosedPosition } from "./rfeed-webhook.js";
import { RFeedTradeExecutor } from "./rfeed-trade-executor.js";
import { HistoryRequestManager } from "./history.js";
import { recordSymbolCustomFlags } from "./custom-symbol-safety.js";

/**
 * The real composition wiring R_Feed's webhook, its trade executor's
 * pending-result promises, its history-request promises, and the
 * custom-symbol safety registry together -- mirrors `EaBridge`'s
 * composition role for the real Dave EA, kept as its own class rather
 * than extending/reusing EaBridge, per the explicit "own webhook/token
 * pair, own tools" separation.
 */
export interface RFeedBridgeEvents {
  onConnect?: (userId: string) => void;
  onClosedPosition?: (userId: string, closed: RFeedClosedPosition) => void;
}

export class RFeedBridge {
  private readonly executors = new Map<string, RFeedTradeExecutor>();
  private readonly historyManagers = new Map<string, HistoryRequestManager>();

  constructor(private readonly events: RFeedBridgeEvents = {}) {}

  getExecutor(userId: string): RFeedTradeExecutor {
    if (!this.executors.has(userId)) this.executors.set(userId, new RFeedTradeExecutor(userId));
    return this.executors.get(userId)!;
  }

  getHistoryManager(userId: string): HistoryRequestManager {
    if (!this.historyManagers.has(userId)) this.historyManagers.set(userId, new HistoryRequestManager(userId));
    return this.historyManagers.get(userId)!;
  }

  createServer() {
    return createRFeedWebhookServer({
      onConnect: (userId) => this.events.onConnect?.(userId),
      onReport: (userId, report) => this.handleReport(userId, report),
    });
  }

  private handleReport(userId: string, report: RFeedReport): void {
    recordSymbolCustomFlags(
      userId,
      [...(report.positions ?? []), ...(report.pendingOrders ?? [])].map((p) => ({ symbol: p.symbol, isCustom: p.isCustom }))
    );
    for (const result of report.results ?? []) {
      this.getExecutor(userId).resolveCommand(result);
    }
    for (const historyResult of report.historyResults ?? []) {
      this.getHistoryManager(userId).resolveHistoryResult(historyResult);
    }
    for (const closed of report.closedPositions ?? []) {
      this.events.onClosedPosition?.(userId, closed);
    }
  }
}
