import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The pullback scalp, run as a cycle (the trader: "when it says sell limit, you buy; when price has
 * reached twenty dollars, you close. If it returns back to the entry, again you close... until it
 * has reached the place for the limit order, then you close it finally").
 *
 *   open   -> the scalp position is live. At +TAKE_PROFIT_USD floating it is closed (profit banked)
 *             and the cycle waits.
 *   wait   -> no position. When price comes back to the scalp's entry, the same scalp is opened
 *             again, and the loop repeats.
 *   finish -> price reaches the limit order's price (the scalp's own TP is there too), the limit
 *             fills or is cancelled, price breaks the scalp's stop, or the cycle is a day old:
 *             anything still open is closed and the cycle ends. From there the limit order is the
 *             trade.
 *
 * Pure decisions (advanceScalpCycle) plus a small store; the timer that drives it lives in the bot.
 */

export const TAKE_PROFIT_USD = 20;
/** "Back to the entry": within this share of the entry-to-limit distance of the entry. */
export const REENTRY_BAND = 0.1;
/** "Reached the limit": within this share of the distance, or past it. */
export const LIMIT_BAND = 0.05;
export const MAX_CYCLE_MS = 24 * 60 * 60_000;
export const REPORT_GRACE_MS = 30_000;

export interface ScalpCycle {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  /** Where the scalp goes in (the first fill) -- the re-entry level. */
  entry: number;
  /** The limit order's price -- the scalp's final target. */
  limitPrice: number;
  limitTicket: string;
  sl: number;
  lots: number;
  /** The live scalp position, while phase is "open". */
  ticket?: string;
  phase: "open" | "wait";
  /** When the current scalp position was opened -- MT5's next report may not list it yet. */
  openedAt?: number;
  rounds: number;
  banked: number;
  createdAt: number;
}

export type ScalpAction =
  | { kind: "none" }
  | { kind: "take"; ticket: string; pnl: number }
  | { kind: "reenter" }
  | { kind: "finish"; reason: string; closeTicket?: string };

export interface ScalpView {
  /** The scalp position, if MT5 still reports it. */
  position?: { ticket: string; pnl?: number; currentPrice?: number };
  /** Is the limit order still waiting in MT5? */
  limitPending: boolean;
  /** Live price for the scalp's side (only needed while waiting). */
  price?: number;
}

export function advanceScalpCycle(c: ScalpCycle, view: ScalpView, now: number, takeUsd = TAKE_PROFIT_USD): ScalpAction {
  const dir = c.side === "buy" ? 1 : -1;
  const span = Math.abs(c.limitPrice - c.entry) || 1e-9;
  const price = view.position?.currentPrice ?? view.price;
  const openTicket = c.phase === "open" && view.position ? c.ticket : undefined;

  if (!view.limitPending && now - c.createdAt < REPORT_GRACE_MS) return { kind: "none" }; // not reported yet
  if (!view.limitPending) return { kind: "finish", reason: "the limit order filled or was removed -- the main trade takes over", closeTicket: openTicket };
  if (now - c.createdAt > MAX_CYCLE_MS) return { kind: "finish", reason: "a day old -- stopping the scalps", closeTicket: openTicket };
  if (price !== undefined && dir * (c.limitPrice - price) <= span * LIMIT_BAND) {
    return { kind: "finish", reason: `price reached the limit at ${c.limitPrice}`, closeTicket: openTicket };
  }

  if (c.phase === "open") {
    if (!view.position) {
      if (c.openedAt !== undefined && now - c.openedAt < REPORT_GRACE_MS) return { kind: "none" }; // not in MT5's report yet
      return { kind: "finish", reason: "the scalp closed on its own (stop loss or target)" };
    }
    if ((view.position.pnl ?? 0) >= takeUsd) return { kind: "take", ticket: c.ticket!, pnl: view.position.pnl! };
    return { kind: "none" };
  }

  // Waiting for price to come back to the entry.
  if (price === undefined) return { kind: "none" };
  if (dir * (price - c.sl) <= 0) return { kind: "finish", reason: `price broke the scalp's stop ${c.sl}` };
  if (dir * (price - c.entry) <= span * REENTRY_BAND) return { kind: "reenter" };
  return { kind: "none" };
}

function path(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "scalp-cycles.json");
}

export function listScalpCycles(userId: string): ScalpCycle[] {
  const p = path(userId);
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, "utf8")) as ScalpCycle[];
  } catch {
    return [];
  }
}

export function saveScalpCycles(userId: string, cycles: ScalpCycle[]): void {
  const p = path(userId);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cycles, null, 2), "utf8");
}

export function registerScalpCycle(userId: string, cycle: ScalpCycle): void {
  saveScalpCycles(userId, [...listScalpCycles(userId).filter((c) => c.id !== cycle.id), cycle]);
}
