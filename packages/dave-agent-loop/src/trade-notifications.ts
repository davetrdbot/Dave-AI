import type { EaClosedPosition, EaPosition } from "@dave/ea-bridge";

/**
 * Real gap fixed (user, with real screenshots of the live bot as proof: "a hardcoded message to
 * send when a trade is closed... same as when a trade is not executed"). Before this, EVERY trade
 * lifecycle update the user saw was narrated by the LLM mid-agent-loop-turn -- slower, costs a real
 * completion call, and inconsistent wording run to run. dave-ea-bridge already reports real closed
 * positions (with real P/L) and real manual closes -- this is the fixed, non-LLM template that
 * turns that already-real data straight into the exact message shape the user asked for, with zero
 * model involvement.
 */

function formatPnl(pnl: number): string {
  const sign = pnl >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(pnl).toFixed(2)}`;
}

const CLOSE_REASON_LABEL: Record<EaClosedPosition["reason"], string> = {
  tp: " (TP hit)",
  sl: " (SL hit)",
  dave: "",
  manual: " (closed manually)",
};

/** A real trade Dave (or TP/SL) closed -- exact format confirmed against the live bot's own real output: "✅ VOL_80 closed. +$1.60." */
export function buildClosedTradeMessage(closed: EaClosedPosition): string {
  const emoji = closed.pnl >= 0 ? "✅" : "🔴";
  return `${emoji} ${closed.symbol} closed. ${formatPnl(closed.pnl)}.${CLOSE_REASON_LABEL[closed.reason]}`;
}

/** A position that disappeared between two real EA reports WITHOUT Dave having sent a close
 *  command -- the user closed it by hand in MT5. No real P/L is available here (the EA only
 *  reports P/L on trades it genuinely tracked closing, per closedPositions), so this stays a
 *  factual notice rather than guessing a number. */
export function buildManualCloseMessage(position: EaPosition): string {
  return `🔔 ${position.symbol} (ticket #${position.ticket}) was closed manually in MT5 -- Dave didn't trigger this.`;
}

/**
 * A setup Dave's real analysis considered but decided NOT to act on -- fixed wrapper around the
 * real reason (still the model's own real judgment; only the envelope/format is hardcoded, so the
 * user always sees the same consistent shape: "⏭ Skipping {symbol}\n{reason}").
 */
export function buildSkippedSetupMessage(symbol: string, reason: string): string {
  return `⏭ Skipping ${symbol}\n${reason}`;
}
