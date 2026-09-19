import { getLastKnownState } from "@dave/ea-bridge";
import type { EaPosition } from "@dave/ea-bridge";
import { getTradeLifecycle } from "@dave/feedback";
import type { DaveDatabase } from "@dave/db";
import { hasAlerted, markAlerted, reconcileOpenTickets } from "./self-aware-alert-store.js";

/**
 * The proactive half of the self-aware SL alert (see self-aware-alert-store.ts for the edge-trigger
 * record). The owner's upgrade request, exact: "when a trade is reaching 50% toward the SL it
 * should alert."
 *
 * Why this exists separately from the in-tick SELF-AWARE ALERT context line in autonomous-tick.ts:
 * that line only appears WHEN an autonomous tick runs, on the round-robin symbol's turn, as text
 * the model may or may not act on. This sweep runs on its own timer regardless of whether
 * autonomous trading is on, reads the live open positions straight off the EA snapshot, and pushes
 * a real Telegram alert the moment a position first crosses 50% toward its stop -- once, then never
 * again for that crossing (the store guarantees that; this repo has been bitten by repeat alerts).
 *
 * Kept as a callback-driven module with no Telegram import, exactly like watch-sweep.ts, so it is
 * directly testable and never reaches for a client of its own.
 */

const SWEEP_INTERVAL_MS = 30_000;

/** The owner's number, exact: alert when a position is at or beyond halfway from entry to its SL. */
export const SL_ALERT_THRESHOLD = 0.5;

export interface SelfAwareSweepDeps {
  db: DaveDatabase;
  userId: string;
  /** Sends the alert. A callback so this module never imports a Telegram client and a test can
   *  assert exactly what would have been sent. */
  notify: (text: string) => Promise<void>;
}

/**
 * How far a position has travelled from its entry toward its SL, as a fraction in [0, 1].
 *
 * DELIBERATELY NOT the abs()-based formula autonomous-tick.ts uses for its visual bar: that one
 * grows when price moves toward the TP as well, which is fine for a two-directional progress bar
 * but WRONG for a danger alert -- it would fire on a winning trade. This is directional: it is only
 * positive when price has moved in the LOSING direction, and clamps a move toward profit to 0.
 *
 * For a long, sl < openPrice, so (open - current)/(open - sl) is positive only when current < open.
 * For a short, sl > openPrice, so the same expression is positive only when current > open. Both
 * cases fall out of the one formula. Returns undefined when the position has no SL or no live price,
 * or the SL sits exactly at entry (no distance to measure) -- a position we must never alert on.
 */
export function slProgressTowardStop(p: EaPosition): number | undefined {
  if (p.sl === undefined || p.currentPrice === undefined) return undefined;
  const denominator = p.openPrice - p.sl;
  if (denominator === 0) return undefined;
  const progress = (p.openPrice - p.currentPrice) / denominator;
  return Math.min(1, Math.max(0, progress));
}

function buildAlert(p: EaPosition, progress: number, reason: string | undefined): string {
  const pct = Math.round(progress * 100);
  const why = reason && reason.trim() ? `\n\n📌 Why I took it: ${reason.trim()}` : "";
  return (
    `⚠️ ${p.symbol} ${p.type.toUpperCase()} (ticket #${p.ticket}) is ${pct}% of the way from entry to its stop — ` +
    `now ${p.currentPrice}, entry ${p.openPrice}, SL ${p.sl}.${why}`
  );
}

/**
 * One real pass. Exported so it is directly testable and so a caller can force a sweep without
 * waiting for the timer. Returns the tickets that newly fired this pass.
 */
export async function runSelfAwareSweep(deps: SelfAwareSweepDeps): Promise<string[]> {
  const { positions } = getLastKnownState(deps.userId);

  // Clear records for positions that have closed, so a future trade can alert again and the store
  // never accumulates dead tickets.
  reconcileOpenTickets(deps.userId, positions.map((p) => p.ticket));

  const fired: string[] = [];
  for (const p of positions) {
    const progress = slProgressTowardStop(p);
    if (progress === undefined || progress < SL_ALERT_THRESHOLD) continue;
    if (hasAlerted(deps.userId, p.ticket)) continue;
    // markAlerted returns true only for the call that claimed it, so two overlapping sweeps can
    // never double-alert on one crossing.
    if (!markAlerted(deps.userId, p.ticket)) continue;

    let reason: string | undefined;
    try {
      // getTradeLifecycle returns every journal row matching the ticket; take the most recent.
      const lifecycle = getTradeLifecycle(deps.db, deps.userId, { ticket: p.ticket });
      const entry = lifecycle[lifecycle.length - 1];
      reason = entry?.reasoning?.join(" ")?.trim() || undefined;
    } catch {
      // No journal entry for this ticket (e.g. a trade placed outside Dave) -- alert without a
      // reason rather than not at all.
    }

    fired.push(p.ticket);
    try {
      await deps.notify(buildAlert(p, progress, reason));
    } catch (err) {
      console.error(`[self-aware-sweep] ${deps.userId}: ticket ${p.ticket} crossed ${SL_ALERT_THRESHOLD} but the alert failed to send:`, err);
    }
  }
  return fired;
}

const activeSweeps = new Map<string, ReturnType<typeof setInterval>>();

/** Returns false if a sweep is already running for this user -- never stacks two timers. */
export function startSelfAwareSweep(deps: SelfAwareSweepDeps, intervalMs = SWEEP_INTERVAL_MS): boolean {
  if (activeSweeps.has(deps.userId)) return false;
  const handle = setInterval(() => {
    // Fire-and-forget on the timer so a slow read never delays the next tick -- but it MUST carry
    // its own catch, or an unhandled rejection would take down the process (see main.ts's fatal
    // guard) over an alert check.
    void runSelfAwareSweep(deps).catch((err) => console.error(`[self-aware-sweep] ${deps.userId}: sweep failed:`, err));
  }, intervalMs);
  activeSweeps.set(deps.userId, handle);
  return true;
}

export function stopSelfAwareSweep(userId: string): boolean {
  const handle = activeSweeps.get(userId);
  if (!handle) return false;
  clearInterval(handle);
  activeSweeps.delete(userId);
  return true;
}
