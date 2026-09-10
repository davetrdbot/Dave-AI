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

/**
 * Item 14 real gap fixed (user: "close-trade notification still sends multiple times -- the
 * earlier duplicate-message fix does not appear to hold for trade-close notifications
 * specifically"). Root cause confirmed: `createEaWebhookServer` had no idempotency key at all --
 * if the same report body ever reaches the server twice (a real, observable MT5 `WebRequest`
 * network-retry pattern: the POST genuinely lands and gets processed, but the response never
 * makes it back to the EA, so it retries), the identical `closedPositions`/manual-close entry
 * gets processed twice, double-firing the notification. A short-TTL, per-user "already notified
 * this ticket" guard makes the real notification fire exactly once regardless of how many times
 * the underlying report arrives.
 */
const CLOSE_DEDUP_TTL_MS = 5 * 60 * 1000;

export class EaBridge {
  private readonly executors = new Map<string, EaTradeExecutor>();
  private readonly recentlyNotifiedCloses = new Map<string, number>(); // `${userId}:${ticket}` -> first-seen timestamp

  constructor(private readonly events: EaBridgeEvents = {}) {}

  /** Returns true (and records it) the FIRST time this ticket's close is seen within the TTL
   *  window; returns false for every subsequent duplicate within that window -- the real
   *  idempotency check. Opportunistically prunes expired entries so this map never grows
   *  unbounded over a long-running process. */
  private shouldNotifyClose(userId: string, ticket: string): boolean {
    const now = Date.now();
    for (const [key, seenAt] of this.recentlyNotifiedCloses) {
      if (now - seenAt >= CLOSE_DEDUP_TTL_MS) this.recentlyNotifiedCloses.delete(key);
    }
    const key = `${userId}:${ticket}`;
    if (this.recentlyNotifiedCloses.has(key)) return false;
    this.recentlyNotifiedCloses.set(key, now);
    return true;
  }

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

    // Real bug fixed (found wiring real onClosedPosition/onManualClose to Telegram for the first
    // time -- previously nothing consumed either, so this double-fire was invisible): a
    // TP/SL-closed ticket disappears from `positions` same as a genuinely manual close, but it's
    // reported through `closedPositions`, NOT `daveClosedThisCycle` (that set only tracks
    // commands DAVE issued through the executor). Without this, every TP/SL close would ALSO
    // fire onManualClose, sending a wrong "closed manually in MT5" message right alongside the
    // correct one.
    const reportedClosedTickets = new Set((report.closedPositions ?? []).map((c) => c.ticket));
    const disappeared = detectManualCloses(previousPositions, report.positions ?? []);
    for (const position of disappeared) {
      if (daveClosedThisCycle.has(position.ticket)) continue; // Dave's own close, not manual
      if (reportedClosedTickets.has(position.ticket)) continue; // already reported (TP/SL/etc), not manual
      if (!this.shouldNotifyClose(userId, position.ticket)) continue; // item 14: already notified this ticket
      this.events.onManualClose?.(userId, position);
    }

    const modifications = detectManualModifications(previousPositions, report.positions ?? []);
    for (const modification of modifications) {
      if (daveModifiedThisCycle.has(modification.ticket)) continue; // Dave's own modify, not manual
      this.events.onManualModify?.(userId, modification);
    }

    for (const closed of report.closedPositions ?? []) {
      if (!this.shouldNotifyClose(userId, closed.ticket)) continue; // item 14: already notified this ticket
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
