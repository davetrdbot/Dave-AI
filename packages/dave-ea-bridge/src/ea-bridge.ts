import { createEaWebhookServer, type EaReport, type EaCommandResult, type EaPosition, type EaClosedPosition } from "./ea-webhook.js";
import { EaTradeExecutor } from "./ea-trade-executor.js";
import { detectManualCloses } from "./manual-close-detector.js";
import { detectManualModifications, type ManualModification } from "./manual-modify-detector.js";
import { runTrailingTick } from "@dave/trading";

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
 * command tracking in a second map. Same idea now covers "modify" too,
 * for manual SL/TP-edit detection (Update 11).
 */
export interface EaBridgeEvents {
  onConnect?: (userId: string) => void;
  onManualClose?: (userId: string, position: EaPosition) => void;
  onManualModify?: (userId: string, modification: ManualModification) => void;
  onCommandResult?: (userId: string, result: EaCommandResult) => void;
  onClosedPosition?: (userId: string, closed: EaClosedPosition) => void;
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
      onConnect: (userId) => this.events.onConnect?.(userId),
      onReport: (userId, report, previous) => this.handleReport(userId, report, previous.positions),
    });
  }

  private handleReport(userId: string, report: EaReport, previousPositions: EaPosition[]): void {
    const daveClosedThisCycle = new Set<string>();
    const daveModifiedThisCycle = new Set<string>();

    for (const result of report.results ?? []) {
      const { daveClosedTicket, daveModifiedTicket } = this.getExecutor(userId).resolveCommand(result);
      if (daveClosedTicket) daveClosedThisCycle.add(daveClosedTicket);
      if (daveModifiedTicket) daveModifiedThisCycle.add(daveModifiedTicket);
      this.events.onCommandResult?.(userId, result);
    }

    const disappeared = detectManualCloses(previousPositions, report.positions ?? []);
    for (const position of disappeared) {
      if (daveClosedThisCycle.has(position.ticket)) continue; // Dave's own close, not manual
      this.events.onManualClose?.(userId, position);
    }

    const modifications = detectManualModifications(previousPositions, report.positions ?? []);
    for (const modification of modifications) {
      if (daveModifiedThisCycle.has(modification.ticket)) continue; // Dave's own modify, not manual
      this.events.onManualModify?.(userId, modification);
    }

    for (const closed of report.closedPositions ?? []) {
      this.events.onClosedPosition?.(userId, closed);
    }

    // Real breakeven/trailing drive loop: every reported open position that
    // carries a real current price gets a real tick against the trailing
    // registry (trading-runtime.ts) -- a no-op for tickets nobody registered,
    // a genuine `executor.modifyOrder()` for one whose stage just fired.
    const executor = this.getExecutor(userId);
    for (const position of report.positions ?? []) {
      if (position.currentPrice === undefined) continue;
      void runTrailingTick(userId, position.ticket, position.currentPrice, executor);
    }
  }
}
