import { assessRiskReward, fmtDistance, type OrderRequest, type RiskSettings } from "@dave/trading";

/**
 * The ONE place a trade's entry, stop and target are worked out -- used by the early check that
 * sends bad levels back to the model, by the final check, and by the order itself.
 *
 * Real bugs fixed (the trader: "check the errors of the risk reward issue -- I told you there is an
 * issue"). Four, all in how the numbers reached the risk:reward check:
 *
 *  1. A FIXED stop (Settings: SL fixed 30 pips) was silently overridden whenever the model wrote a
 *     stop of its own -- the model's number won over the trader's setting.
 *  2. Fixed pips were measured from the LIVE price, not the order's entry. For a BUY_LIMIT well
 *     under price, "30 pips below" landed near -- or above -- the limit itself, and the trade was
 *     refused as "stop on the wrong side", or passed with a meaningless ratio.
 *  3. A market order's ratio was measured from the entry the MODEL typed (often a stale price from
 *     the analysis), not the price it actually fills at -- and from the bid even for a buy, which
 *     fills at the ask. A trade could clear 2:1 on paper and be 1.4:1 in reality.
 *  4. The early "fix your levels once" check looked only at the model's raw numbers, while the
 *     final check looked at the real order (fixed levels applied). They disagreed: trades were
 *     refused at the end with no real retry, under a message claiming one had happened.
 *
 * Plus a gap: with TP off (no target at the broker) there was no target to measure, so the floor
 * never applied at all. The model now names the target it expects anyway (`target`), and that is
 * what the floor is checked against -- nothing is placed at the broker.
 */

export type TradeAction = "BUY" | "SELL" | "BUY_LIMIT" | "SELL_LIMIT" | "BUY_STOP" | "SELL_STOP";

export interface TradeLevels {
  /** The price the trade opens at: the pending entry, or the live ask (buy) / bid (sell). */
  entry: number;
  sl?: number;
  /** Placed at the broker. */
  tp?: number;
  /** What the ratio is measured against: tp, or the planned target when TP is off. */
  rrTarget?: number;
  slSource: "fixed" | "model" | "none";
  tpSource: "fixed" | "model" | "planned" | "rr" | "none";
  ratio?: number;
  /** Why the trade can't go ahead as given (plain words, shown to the model and the trader). */
  problem?: string;
  /** The problem is in the setup itself (pip size unknown) -- asking the model again won't help. */
  fatal?: boolean;
}

const isBuy = (a: TradeAction) => a === "BUY" || a === "BUY_LIMIT" || a === "BUY_STOP";
const isPending = (a: TradeAction) => a !== "BUY" && a !== "SELL";
const ORDER_TYPE: Record<TradeAction, OrderRequest["type"]> = {
  BUY: "buy",
  SELL: "sell",
  BUY_LIMIT: "buy_limit",
  SELL_LIMIT: "sell_limit",
  BUY_STOP: "buy_stop",
  SELL_STOP: "sell_stop",
};

/** The live price a market order fills at: the ask for a buy, the bid for a sell. */
export function marketPrice(action: TradeAction, price: { bid?: number; ask?: number; close?: number } | undefined): number {
  if (!price) return 0;
  const v = isBuy(action) ? (price.ask ?? price.bid ?? price.close) : (price.bid ?? price.ask ?? price.close);
  return typeof v === "number" && v > 0 ? v : 0;
}

/** The price an open trade is closed at -- and so what its stop is triggered by: the bid for a buy,
 *  the ask for a sell. The right reference for "is this stop inside normal noise". */
export function exitPrice(action: TradeAction, price: { bid?: number; ask?: number; close?: number } | undefined): number {
  if (!price) return 0;
  const v = isBuy(action) ? (price.bid ?? price.ask ?? price.close) : (price.ask ?? price.bid ?? price.close);
  return typeof v === "number" && v > 0 ? v : 0;
}

export function resolveTradeLevels(input: {
  action: TradeAction;
  decision: { entry?: number; sl?: number; tp?: number; target?: number };
  risk: Pick<RiskSettings, "slMode" | "slValue" | "tpMode" | "tpValue">;
  price: { bid?: number; ask?: number; close?: number } | undefined;
  pip?: number;
  minRiskReward: number;
}): TradeLevels {
  const { action, decision, risk, pip, minRiskReward } = input;
  const buy = isBuy(action);
  const dir = buy ? 1 : -1;
  const entry = isPending(action) ? (decision.entry ?? 0) : marketPrice(action, input.price);
  const out: TradeLevels = { entry, slSource: "none", tpSource: "none" };
  if (!(entry > 0)) return { ...out, problem: isPending(action) ? `${action} needs an entry price` : "there's no live price to open at" };

  // The stop. A fixed stop is the trader's rule and wins over anything the model wrote.
  if (risk.slMode === "on" && risk.slValue !== undefined) {
    if (pip === undefined) return { ...out, problem: `this symbol's pip size couldn't be worked out, so a fixed ${risk.slValue}-pip stop can't be placed safely`, fatal: true };
    out.sl = round(entry - dir * risk.slValue * pip, entry);
    out.slSource = "fixed";
  } else if (risk.slMode === "auto") {
    if (decision.sl === undefined) return { ...out, problem: "no stop loss was given (SL is set to Dave decides)" };
    out.sl = decision.sl;
    out.slSource = "model";
  } else if (decision.sl !== undefined) {
    // SL "off" means no fixed rule -- not "trade without a stop". The stop Dave gives is used.
    out.sl = decision.sl;
    out.slSource = "model";
  }

  // The target.
  if (risk.tpMode === "on" && risk.tpValue !== undefined) {
    if (pip === undefined) return { ...out, problem: `this symbol's pip size couldn't be worked out, so a fixed ${risk.tpValue}-pip target can't be placed safely`, fatal: true };
    out.tp = round(entry + dir * risk.tpValue * pip, entry);
    out.rrTarget = out.tp;
    out.tpSource = "fixed";
  } else if (out.sl !== undefined && minRiskReward > 0) {
    // Exact risk:reward (the trader: "exact R:R, not minimum"): the target is placed at exactly the
    // stop's distance times the ratio. Whatever target the model wrote is replaced.
    const risked = dir * (entry - out.sl);
    if (!(risked > 0)) return { ...out, problem: `the stop loss (${out.sl}) is on the wrong side of the ${buy ? "BUY" : "SELL"} entry (${entry})` };
    out.tp = round(entry + dir * risked * minRiskReward, entry);
    out.rrTarget = out.tp;
    out.tpSource = "rr";
    out.ratio = minRiskReward;
    return out;
  } else if (risk.tpMode === "auto") {
    if (decision.tp === undefined) return { ...out, problem: "no take profit was given (TP is set to Dave decides)" };
    out.tp = decision.tp;
    out.rrTarget = out.tp;
    out.tpSource = "model";
  } else if (decision.tp !== undefined) {
    // TP "off" means no fixed rule: a take profit Dave gives is placed, as it always was.
    out.tp = decision.tp;
    out.rrTarget = out.tp;
    out.tpSource = "model";
  } else if (decision.target !== undefined) {
    // No take profit at the broker -- but the idea still has a target, and the floor is checked on it.
    out.rrTarget = decision.target;
    out.tpSource = "planned";
  }

  // The checks, on exactly the numbers that will be used.
  if (out.sl !== undefined && out.rrTarget === undefined && risk.tpMode === "off") {
    return { ...out, problem: `no target was named -- give tp (placed at the broker) or target (where you expect price to go, not placed); the ${minRiskReward}:1 floor is checked against it` };
  }
  const rr = assessRiskReward({ symbol: "", type: ORDER_TYPE[action], lots: 1, sl: out.sl, tp: out.rrTarget }, entry, minRiskReward);
  if (rr.ratio !== undefined) out.ratio = Math.round(rr.ratio * 100) / 100;
  if (!rr.ok) {
    const fixedNote =
      out.slSource === "fixed"
        ? ` Your stop is FIXED at ${risk.slValue} pips (${out.sl}) -- only the entry${isPending(action) ? "" : " (use a pending order)"} or the target can change: the target must be at least ${fmtDistance(Math.abs(entry - (out.sl as number)) * minRiskReward)} away from the entry.`
        : "";
    return { ...out, problem: `${rr.reason}.${fixedNote}` };
  }
  return out;
}

/** Keeps the fixed levels at the instrument's own precision (no 1.1000000000000001). */
function round(v: number, like: number): number {
  const decimals = Math.min(8, Math.max(0, (String(like).split(".")[1] ?? "").length + 1));
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}


/** The line for the model: how the levels work under THIS trader's settings. */
export function levelsGuidance(risk: Pick<RiskSettings, "slMode" | "slValue" | "tpMode" | "tpValue">, minRiskReward: number): string {
  const parts = [];
  if (risk.slMode === "on") parts.push(`your stop is FIXED at ${risk.slValue} pips from the entry (set automatically -- don't give sl)`);
  else if (risk.slMode === "auto") parts.push("you set the stop (sl) where the idea is proven wrong");
  else parts.push("there's no fixed stop rule (SL off) -- still give sl where the idea is proven wrong");
  if (risk.tpMode === "on") {
    parts.push(`the target is FIXED at ${risk.tpValue} pips (set automatically)`);
    return `LEVELS: ${parts.join("; ")}. Market orders are measured from the live price they fill at (ask for a buy, bid for a sell), pending orders from their entry. The target must be at least ${minRiskReward}x as far from the entry as the stop, or the trade is refused.`;
  }
  parts.push(`the take profit is set AUTOMATICALLY at exactly 1:${minRiskReward} -- ${minRiskReward}x the stop's distance from the entry -- so any tp you give is replaced; choose the stop so that target is realistic, or skip`);
  return `LEVELS: ${parts.join("; ")}. Market orders are measured from the live price they fill at (ask for a buy, bid for a sell), pending orders from their entry.`;
}
