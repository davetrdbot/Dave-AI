import type { OrderRequest } from "./order-types.js";
import type { TradeExecutor } from "./trade-executor.js";
import { ABSOLUTE_MIN_LOTS, tradeExecuteWithMarginRetry } from "./margin-aware-execute.js";
import { evaluateAccountAwareness } from "./account-awareness.js";
import { registerScalpCycle, TAKE_PROFIT_USD } from "./scalp-cycle.js";

/**
 * The pullback scalp that rides price INTO a limit order (the trader: "when you place a sell limit,
 * we know there is a short pullback up to it before it triggers -- instead of waiting, enter the
 * pullback the opposite way, a scalp, with its own SL and TP1/TP2. TP1 exactly at the sell limit.
 * Same for a buy limit.")
 *
 *   SELL LIMIT at L  ->  BUY now toward L, SL below where the pullback idea is wrong.
 *   BUY LIMIT  at L  ->  mirror image: SELL now toward L.
 *
 * One position, target L, run as a cycle (scalp-cycle.ts -- the trader's later rule): +$20 banked,
 * in again when price returns to the entry, closed for good at L. The plan still computes a TP2
 * past L for callers that show it, but nothing is placed there any more.
 */

export type LimitType = "buy_limit" | "sell_limit";

export interface PullbackScalpInput {
  limitType: LimitType;
  limitEntry: number;
  /** The limit order's own stop loss -- TP2 must stay short of it. */
  limitSl?: number;
  /** Live price now: where the scalp opens. */
  price: number;
  /** The limit order's size; each scalp part is half of it (never below the broker minimum). */
  lots: number;
  /** Dave's own levels for the scalp, when given. Anything on the wrong side is replaced by a default. */
  sl?: number;
  tp2?: number;
  /** The trader's risk:reward floor, measured to TP1. */
  minRiskReward: number;
}

export interface PullbackScalpPlan {
  side: "buy" | "sell";
  lotsEach: number;
  sl: number;
  tp1: number;
  tp2: number;
  /** Which levels were Dave's and which were filled in. */
  defaulted: { sl: boolean; tp2: boolean };
}

export type PullbackScalpDecision = { ok: true; plan: PullbackScalpPlan } | { ok: false; reason: string };

export function isLimitType(type: string): type is LimitType {
  return type === "buy_limit" || type === "sell_limit";
}

export function planPullbackScalp(input: PullbackScalpInput): PullbackScalpDecision {
  const { limitType, limitEntry, limitSl, price } = input;
  // The scalp trades toward the limit: under a SELL LIMIT that is up (a buy), over a BUY LIMIT down.
  const dir = limitType === "sell_limit" ? 1 : -1;
  const side = dir === 1 ? "buy" : "sell";
  const distance = dir * (limitEntry - price);
  if (!(price > 0) || !(distance > 0)) {
    return { ok: false, reason: `price ${price} is already at or past the ${limitType.replace("_", " ")} at ${limitEntry} -- no pullback left to ride` };
  }
  const tp1 = limitEntry;

  // TP2: past the limit, short of the limit's own stop.
  const slRoom = limitSl !== undefined && dir * (limitSl - limitEntry) > 0 ? Math.abs(limitSl - limitEntry) : undefined;
  const tp2Valid =
    input.tp2 !== undefined && dir * (input.tp2 - tp1) > 0 && (slRoom === undefined || Math.abs(input.tp2 - tp1) < slRoom);
  const tp2 = tp2Valid ? input.tp2! : tp1 + dir * (slRoom !== undefined ? slRoom * 0.5 : distance * 0.5);

  // SL: on the losing side of the entry, sized so TP1 still clears the floor.
  const floor = Math.max(input.minRiskReward, 0.5);
  const slValid = input.sl !== undefined && dir * (price - input.sl) > 0;
  const sl = slValid ? input.sl! : price - dir * (distance / floor);
  const risk = Math.abs(price - sl);
  const ratio = distance / risk;
  if (ratio + 1e-9 < input.minRiskReward) {
    return {
      ok: false,
      reason: `the pullback only pays ${ratio.toFixed(2)}:1 to TP1 (risking ${round(risk)} to make ${round(distance)}) -- below your ${input.minRiskReward}:1 floor`,
    };
  }

  const lotsEach = Math.max(ABSOLUTE_MIN_LOTS, Math.floor((input.lots / 2) * 100 + 1e-9) / 100);
  return { ok: true, plan: { side, lotsEach, sl, tp1, tp2, defaulted: { sl: !slValid, tp2: !tp2Valid } } };
}

/**
 * The scalp is optional (the trader: "if there are already too many trades and it would break the
 * risk:reward or leverage, it should not take it -- and it shouldn't be compulsory"). It adds TWO
 * positions, so the account must have room for both: under the max-open-trades limit after both,
 * and free margin not already critically low. Same gate every other trade goes through.
 */
export function pullbackScalpRoom(
  account: { balance: number; freeMargin?: number; leverage?: number } | undefined,
  openPositionsCount: number,
  maxOpenTrades: number | undefined,
): { ok: boolean; reason?: string } {
  if (!account) return { ok: true };
  // Room for two more means the count after the first one must still be under the limit.
  const r = evaluateAccountAwareness({ ...account, openPositionsCount: openPositionsCount + 1 }, { maxOpenTrades });
  if (r.ok) return r;
  return {
    ok: false,
    reason:
      maxOpenTrades !== undefined && openPositionsCount + 2 > maxOpenTrades
        ? `the account has ${openPositionsCount} open and a limit of ${maxOpenTrades} -- no room for the scalp's two positions`
        : "free margin is already too low for two more positions (leverage)",
  };
}

export interface PlacedPullbackScalp {
  plan: PullbackScalpPlan;
  tickets: { tp1?: string };
  errors: string[];
  lots?: number;
  /** Running as a $-take / re-entry cycle (scalp-cycle.ts). */
  cycled?: boolean;
}

/**
 * Opens the scalp at market -- one position, aimed at the limit's price -- and, when `cycle` is
 * given, hands it to the scalp cycle (scalp-cycle.ts): bank TAKE_PROFIT_USD at a time, go in again
 * when price comes back to this entry, close for good when price reaches the limit. A failure is
 * reported, never thrown -- the limit order it accompanies is already placed and stands on its own.
 */
export async function placePullbackScalp(
  executor: TradeExecutor,
  symbol: string,
  plan: PullbackScalpPlan,
  note: { comment?: string; pushMessage?: string } = {},
  cycle?: { userId: string; limitTicket: string; entryPrice: number },
): Promise<PlacedPullbackScalp> {
  const tickets: PlacedPullbackScalp["tickets"] = {};
  const errors: string[] = [];
  const lots = Math.max(ABSOLUTE_MIN_LOTS, Math.round(plan.lotsEach * 2 * 100) / 100);
  try {
    const placed = await tradeExecuteWithMarginRetry(executor, {
      symbol,
      type: plan.side,
      lots,
      sl: plan.sl,
      tp: plan.tp1,
      comment: (note.comment ?? "Dave pullback").slice(0, 28),
      pushMessage: note.pushMessage,
    });
    tickets.tp1 = placed.ticket;
    if (cycle) {
      registerScalpCycle(cycle.userId, {
        id: placed.ticket,
        symbol,
        side: plan.side,
        entry: cycle.entryPrice,
        limitPrice: plan.tp1,
        limitTicket: cycle.limitTicket,
        sl: plan.sl,
        lots: placed.placedLots,
        ticket: placed.ticket,
        phase: "open",
        openedAt: Date.now(),
        rounds: 0,
        banked: 0,
        createdAt: Date.now(),
      });
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  return { plan, tickets, errors, lots, cycled: !!cycle && !!tickets.tp1 };
}

/** One line for chat. */
export function describePullbackScalp(symbol: string, placed: PlacedPullbackScalp): string {
  const p = placed.plan;
  if (!placed.tickets.tp1) return `🔁 Pullback scalp: not opened${placed.errors.length ? ` -- ${placed.errors.join("; ")}` : ""}`;
  const loop = placed.cycled ? `banking $${TAKE_PROFIT_USD} at a time, going in again when price comes back, closing for good at the limit ${round(p.tp1)}` : `target the limit ${round(p.tp1)}`;
  return `🔁 Pullback scalp: ${p.side.toUpperCase()} ${symbol} ${placed.lots} lots #${placed.tickets.tp1}, SL ${round(p.sl)} -- ${loop}`;
}

function round(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}
