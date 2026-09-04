import { createEaWebhookServer, type EaReport, type EaCommandResult, type EaPosition } from "./ea-webhook.js";
import { EaTradeExecutor } from "./ea-trade-executor.js";
import { detectManualCloses } from "./manual-close-detector.js";

/**
 * The real composition wiring the webhook, the executor's pending-result
 * promises, and manual-close detection together -- this is what a real
 * deployed Dave process would run one instance of per user with an EA.
 *
 * Real subtlety handled here, not left as a gap: a position Dave just
 * told the EA to close will legitimately disappear from the next
 * report too -- that must NOT be misreported as a manual close.
 * EaTradeExecutor.resolveCommand() already tracks which ticket a
 * successfully-resolved "close" command was for (it has to, to fulfil
 * the right promise), so this layer reuses that instead of duplicating
 * command tracking in a second map.
 */
export interface EaBridgeEvents {
  onManualClose?: (userId: string, position: EaPosition) => void;
  onCommandResult?: (userId: string, result: EaCommandResult) => void;
}

export class EaBridge {
  private readonly executors = new Map<string, EaTradeExecutor>();

  constructor(private readonly events: EaBridgeEvents = {}) {}

  getExecutor(userId: string): EaTradeExecutor {
    if (!this.executors.has(userId)) this.executors.set(userId, new EaTradeExecutor(userId));
    return this.executors.get(userId)!;
  }

  createServer() {
    return createEaWebhookServer({
      onReport: (userId, report, previous) => this.handleReport(userId, report, previous.positions),
    });
  }

  private handleReport(userId: string, report: EaReport, previousPositions: EaPosition[]): void {
    const daveClosedThisCycle = new Set<string>();

    for (const result of report.results ?? []) {
      const { daveClosedTicket } = this.getExecutor(userId).resolveCommand(result);
      if (daveClosedTicket) daveClosedThisCycle.add(daveClosedTicket);
      this.events.onCommandResult?.(userId, result);
    }

    const disappeared = detectManualCloses(previousPositions, report.positions ?? []);
    for (const position of disappeared) {
      if (daveClosedThisCycle.has(position.ticket)) continue; // Dave's own close, not manual
      this.events.onManualClose?.(userId, position);
    }
  }
}
