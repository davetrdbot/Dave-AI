import type { EaClosedPosition, EaPosition, ManualModification } from "@dave/ea-bridge";
import type { OrderRequest } from "@dave/trading";

/**
 * Real gap fixed (user, with real screenshots of the live bot as proof: "a hardcoded message to
 * send when a trade is closed... same as when a trade is not executed"). Before this, EVERY trade
 * lifecycle update the user saw was narrated by the LLM mid-agent-loop-turn -- slower, costs a real
 * completion call, and inconsistent wording run to run. dave-ea-bridge already reports real closed
 * positions (with real P/L) and real manual closes -- this is the fixed, non-LLM template that
 * turns that already-real data straight into the exact message shape the user asked for, with zero
 * model involvement.
 */

export function formatPnl(pnl: number): string {
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
 * Real gap fixed (the trader: "find bugs this bot"): manual-modify-detector.ts genuinely detects an
 * SL/TP the trader moved by hand in MT5, EaBridge genuinely re-emits it as onManualModify -- and
 * main.ts never wired that event to anything at all, so it reached no one. Same factual,
 * non-LLM shape as the manual-close notice above. Already edge-triggered upstream (the detector
 * only fires on a real value CHANGE against the previous report), so this cannot repeat for an
 * unchanged level no matter how often the EA reports.
 */
export function buildManualModifyMessage(modification: ManualModification): string {
  const label = modification.field.toUpperCase();
  const from = modification.oldValue === undefined || modification.oldValue === 0 ? "none" : String(modification.oldValue);
  const to = modification.newValue === undefined || modification.newValue === 0 ? "none" : String(modification.newValue);
  return `🔧 ${modification.symbol} (ticket #${modification.ticket}): ${label} changed manually in MT5 -- ${from} → ${to}. Dave didn't trigger this, but he'll respect it from here.`;
}

/**
 * The real forked liveness watchdog (main.ts's startWatchdog) detecting that this bot process has
 * stopped writing its own heartbeat -- i.e. Dave is hung or dying. main.ts used to log this to the
 * console and nothing else, under a comment that described a "best-effort alert" which was never
 * written. Sent from the watchdog's own separate process channel, so it can still reach the trader
 * when the main loop itself is the thing that's stuck.
 */
export function buildWatchdogAlertMessage(eventType: string, stalenessMs?: number): string {
  if (eventType === "recovered") return "🟢 Dave's core process is responding again.";
  const stale = stalenessMs === undefined ? "" : ` (no sign of life for ${Math.round(stalenessMs / 1000)}s)`;
  return `🚨 Dave's core process has stopped responding${stale} -- autonomous trading is NOT running right now. It usually restarts itself; if this doesn't clear shortly, check the host.`;
}

/**
 * A setup Dave's real analysis considered but decided NOT to act on -- fixed wrapper around the
 * real reason (still the model's own real judgment; only the envelope/format is hardcoded, so the
 * user always sees the same consistent shape: "⏭ Skipping {symbol}\n{reason}").
 */
export function buildSkippedSetupMessage(symbol: string, reason: string): string {
  return `⏭ Skipping ${symbol}\n${reason}`;
}

/** Real gap fixed (user, live, pasted an actual example: a trade message whose reasoning was one
 *  dense, unbounded, multi-sentence wall-of-text paragraph dumped verbatim after "💡" -- "very jam
 *  packed and not neat... it should be neat and clean"). Bounds a model's raw reasoning to ~2
 *  sentences / ~220 chars for the message the user actually sees -- the FULL reason is still saved
 *  in full to the trade journal (trade-log.ts), this only shortens what's pushed to Telegram. */
export function summarizeReason(reason: string, maxSentences = 2, maxChars = 220): string {
  const sentences = reason
    .split(/(?<=[.!?])\s+/)
    .slice(0, maxSentences)
    .join(" ");
  if (sentences.length <= maxChars) return sentences;
  // Real bug fixed (user, live: a real message ended "...supply 360307-36…" -- a raw character
  // slice cut mid-word/mid-number). Back up to the last real word boundary before the cap instead
  // of hard-cutting wherever the character count happens to land.
  const cut = sentences.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Real feature (user, live: wants visual TP/SL progress bars, and a self-aware alert when a
 *  trade is close to hitting SL -- "like the screenshot"). Pure, real math -- no placeholder
 *  bar: progress is genuine distance travelled from entry toward target, clamped to [0, 1] so a
 *  price that has already overshot the target (or reversed past entry) never renders past a full
 *  bar or a negative one. Works identically for BUY and SELL -- direction never enters the
 *  computation, only the real distances do, so a SELL's SL sitting numerically ABOVE entry (price
 *  going up hurts a SELL) still produces the correct progress purely from |current - entry| vs.
 *  |target - entry|. Division-by-zero (target === entry -- e.g. no real SL/TP distance at all) is
 *  guarded to a flat 0%, never NaN/Infinity. */
export function buildProgressBar(entry: number, current: number, target: number, width = 10): string {
  const denominator = Math.abs(target - entry);
  const rawProgress = denominator === 0 ? 0 : Math.abs(current - entry) / denominator;
  const progress = Math.min(1, Math.max(0, rawProgress));
  const filled = Math.round(progress * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  return `${bar} ${Math.round(progress * 100)}%`;
}

/** Real gap fixed (user: "implement confidence rate so when it's placing a trade it should send
 *  like the screenshot" -- and separately, "confirm if the bot took for trade even to set tp and
 *  set sl too"): a real, hardcoded trade-placement message that ALWAYS fires for every trade that
 *  actually opens -- not only ones a confidence score happened to be attached to -- so the user
 *  can always see whether a trade genuinely fired and what SL/TP it carries. Fixed shape, zero LLM
 *  prose, same non-LLM pattern as buildClosedTradeMessage above. */
export function buildTradePlacedMessage(order: OrderRequest, ticket: string, confidence?: number): string {
  const levels = [order.sl !== undefined ? `SL ${order.sl}` : "SL: not set", order.tp !== undefined ? `TP ${order.tp}` : "TP: not set"].join(" / ");
  return [
    `📈 ${order.symbol} ${order.type.toUpperCase()} ${order.lots} lots opened. Ticket #${ticket}.`,
    typeof confidence === "number" ? `🎯 Confidence: ${confidence}%` : null,
    levels,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Below the user's confidence threshold and auto-approval is off -- a real Approve/Decline round
 *  trip is required before this order is ever sent, per the user's explicit request. */
export function buildTradeApprovalRequestMessage(order: OrderRequest, confidence: number, threshold: number, reason?: string): string {
  return [
    `⚠️ ${order.symbol} ${order.type.toUpperCase()} ${order.lots} lots -- confidence ${confidence}% is below your ${threshold}% threshold.`,
    reason ? reason : null,
    "Approve to place it, or decline to skip.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Real gap fixed (user, live: "/stop_trading... when it sees a set-up like a sniper tier
 *  level... it should ask the user approve or decline"). Deliberately separate wording from
 *  buildTradeApprovalRequestMessage above -- that one means "below threshold," the opposite of
 *  what's true here (this fires because confidence is genuinely ABOVE the sniper-tier bar while
 *  autonomous trading is stopped), so reusing that exact copy would read as factually wrong
 *  ("confidence 90% is below your 85% threshold" when 90 is not below 85). */
export function buildSniperTierWhileStoppedMessage(order: OrderRequest, confidence: number, sniperTierBar: number, reason?: string): string {
  return [
    `⭐ ${order.symbol} ${order.type.toUpperCase()} ${order.lots} lots -- ${confidence}% confidence, genuinely sniper-tier (≥${sniperTierBar}%) while trading is stopped.`,
    reason ? reason : null,
    "Approve to place it, or decline to skip.",
  ]
    .filter(Boolean)
    .join("\n");
}
