import type { NousTrade } from "./store.js";

/**
 * What to do with one copied trade right now -- pure, so every rule is testable.
 *
 * The trader's rules for signal trades:
 *   - The broker's take profit is TP1 ("only use TP1").
 *   - When TP1 is reached, the stop goes to the entry (breakeven) and the target becomes TP2.
 *     A broker closes a position the instant its TP is touched, so the move happens just BEFORE
 *     TP1 -- at NEAR_TP1 of the way there. If price spikes straight through between two EA reports,
 *     the trade simply closes at TP1: still the trader's rule, and always in profit.
 *   - Losing for LOSING_ASK_MS, or losing while the account's margin is stretched -> ask Dave
 *     whether the setup is still valid, at most once every REASK_MS.
 */

export const NEAR_TP1 = 0.9;
export const LOSING_ASK_MS = 5 * 60_000;
export const REASK_MS = 30 * 60_000;

export interface LivePosition {
  openPrice: number;
  currentPrice?: number;
  pnl?: number;
}

export interface AccountView {
  balance: number;
  equity?: number;
  margin?: number;
  freeMargin?: number;
}

export type NousAction = { kind: "moveToBreakeven"; sl: number; tp: number } | { kind: "askValidity"; why: string };

/** Margin level under 200%, or less than a quarter of the balance left free. */
export function marginStretched(a: AccountView | undefined): boolean {
  if (!a) return false;
  if (a.margin && a.margin > 0 && a.equity !== undefined && (a.equity / a.margin) * 100 < 200) return true;
  return a.freeMargin !== undefined && a.balance > 0 && a.freeMargin < a.balance * 0.25;
}

/** Mutates `trade` (stage, losingSince, validityAskedAt) and returns what the caller must do. */
export function advanceNousTrade(trade: NousTrade, pos: LivePosition, account: AccountView | undefined, now: number): NousAction[] {
  const actions: NousAction[] = [];
  const dir = trade.side === "buy" ? 1 : -1;
  const entry = pos.openPrice || trade.entry;
  const price = pos.currentPrice;

  if (trade.stage === "tp1" && trade.tp2 !== undefined && price !== undefined) {
    const span = Math.abs(trade.tp1 - entry);
    const progress = span > 0 ? (dir * (price - entry)) / span : 0;
    if (progress >= NEAR_TP1) {
      trade.stage = "tp2";
      trade.losingSince = undefined;
      actions.push({ kind: "moveToBreakeven", sl: entry, tp: trade.tp2 });
      return actions;
    }
  }

  const losing = pos.pnl !== undefined ? pos.pnl < 0 : price !== undefined && dir * (price - entry) < 0;
  if (!losing) {
    trade.losingSince = undefined;
    return actions;
  }
  trade.losingSince ??= now;
  const recentlyAsked = trade.validityAskedAt !== undefined && now - trade.validityAskedAt < REASK_MS;
  if (recentlyAsked) return actions;
  const losingFor = now - trade.losingSince;
  if (losingFor >= LOSING_ASK_MS) {
    trade.validityAskedAt = now;
    actions.push({ kind: "askValidity", why: `losing for ${Math.round(losingFor / 60_000)} min` });
  } else if (marginStretched(account)) {
    trade.validityAskedAt = now;
    actions.push({ kind: "askValidity", why: "losing while the account's margin is stretched" });
  }
  return actions;
}
