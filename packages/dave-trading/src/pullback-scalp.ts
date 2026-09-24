import type { OrderRequest } from "./order-types.js";
import type { TradeExecutor } from "./trade-executor.js";
import { ABSOLUTE_MIN_LOTS, tradeExecuteWithMarginRetry } from "./margin-aware-execute.js";

/**
 * The pullback scalp that rides price INTO a limit order (the trader: "when you place a sell limit,
 * we know there is a short pullback up to it before it triggers -- instead of waiting, enter the
 * pullback the opposite way, a scalp, with its own SL and TP1/TP2. TP1 exactly at the sell limit.
 * Same for a buy limit.")
 *
 *   SELL LIMIT at L  ->  BUY now, TP1 = L exactly, TP2 past L (the overshoot/sweep through the
 *                        level -- the trader's choice), SL below where the pullback idea is wrong.
 *   BUY LIMIT  at L  ->  mirror image: SELL now, TP1 = L, TP2 below L.
 *
 * Two targets on one idea are two positions (MT5 gives a position one TP): part A closes at TP1,
 * part B at TP2, both with the same SL. TP2 is kept short of the limit order's own stop loss -- past
 * that, the limit's idea is already dead.
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

export interface PlacedPullbackScalp {
  plan: PullbackScalpPlan;
  tickets: { tp1?: string; tp2?: string };
  errors: string[];
}

/** Opens both parts at market. A failure of either is reported, never thrown -- the limit order
 *  it accompanies is already placed and stands on its own. */
export async function placePullbackScalp(
  executor: TradeExecutor,
  symbol: string,
  plan: PullbackScalpPlan,
  note: { comment?: string; pushMessage?: string } = {},
): Promise<PlacedPullbackScalp> {
  const tickets: PlacedPullbackScalp["tickets"] = {};
  const errors: string[] = [];
  for (const [key, tp] of [["tp1", plan.tp1], ["tp2", plan.tp2]] as const) {
    const order: OrderRequest = {
      symbol,
      type: plan.side,
      lots: plan.lotsEach,
      sl: plan.sl,
      tp,
      comment: `${note.comment ?? "Dave pullback"} ${key.toUpperCase()}`.slice(0, 28).trimEnd(),
      pushMessage: note.pushMessage,
    };
    try {
      const placed = await tradeExecuteWithMarginRetry(executor, order);
      tickets[key] = placed.ticket;
    } catch (err) {
      errors.push(`${key.toUpperCase()} part: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { plan, tickets, errors };
}

/** One line for chat. */
export function describePullbackScalp(symbol: string, placed: PlacedPullbackScalp): string {
  const p = placed.plan;
  const opened = [placed.tickets.tp1 && `#${placed.tickets.tp1} → TP1 ${round(p.tp1)}`, placed.tickets.tp2 && `#${placed.tickets.tp2} → TP2 ${round(p.tp2)}`].filter(Boolean);
  const head = `🔁 Pullback scalp: ${p.side.toUpperCase()} ${symbol}, ${opened.length} × ${p.lotsEach} lots, riding ${p.side === "buy" ? "up" : "down"} to the limit`;
  const body = opened.length ? `${opened.join(", ")}, SL ${round(p.sl)}` : "not opened";
  const errs = placed.errors.length ? `\n⚠️ ${placed.errors.join("; ")}` : "";
  return `${head}\n${body}${errs}`;
}

function round(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}
