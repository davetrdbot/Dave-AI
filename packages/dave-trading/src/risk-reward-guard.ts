import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendSettingsLogEntry } from "./settings-log.js";
import type { OrderRequest } from "./order-types.js";

/**
 * Real bug fixed (the trader, live, pointing at his own MT5 chart on a running VOL_80 position):
 *
 *   entry 196,741 | TP 200,500 = +$187.95 (3,759 points) | SL 192,800 = -$197.05 (3,941 points)
 *
 * The stop was WIDER than the target. Dave risked $197.05 to make $187.95 -- a risk:reward of
 * 0.95:1, upside down, needing a >51% win rate just to break even. Confirmed by grep that this
 * codebase had NO risk:reward validation of any kind, and no sanity check that SL/TP even sit on
 * the correct sides of the entry. The only stop-related guard anywhere was isSlTooTight (a stop
 * too NARROW for current ATR) -- nothing ever looked at the stop being too wide relative to the
 * target it was paired with.
 *
 * Deliberately scoped to what can be computed correctly and cheaply from the order itself.
 * Distance ratios need no contract size, no point value and no currency conversion, so they are
 * exact for forex, metals and synthetic indices alike. A currency-denominated "max % of balance"
 * cap is NOT attempted here: the per-lot point value for a synthetic index is only known to MT5,
 * and guessing it would risk either waving through a catastrophic trade or -- the failure mode
 * this codebase has already hit once today -- rejecting every trade and silently bricking the bot.
 */

/** Never risk more than you stand to gain. A floor, not a strategy: 1.0 is the line below which a
 *  trade is structurally losing regardless of how good the read is. Deliberately not set to a
 *  textbook 1.5/2.0 -- that is a strategy opinion, and imposing one here would silently veto
 *  setups the trader may legitimately want. */
export const MIN_RISK_REWARD_RATIO = 1.0;

/**
 * Float-noise tolerance on the ratio comparison. Real bug this fixes, caught by the existing
 * step106 suite before this guard ever shipped: a mathematically EXACT 1:1 trade does not compute
 * as 1 in binary floating point. For a real EURUSD case from that test --
 * entry 1.095, SL 1.11, TP 1.08 -- the two distances come out as 0.015000000000000124 and
 * 0.014999999999999902, giving a ratio of 0.9999999999999852, which is strictly below 1.0. The
 * guard therefore refused a genuinely valid, deliberately even-money trade. Wide enough to absorb
 * that representation noise, and many orders of magnitude too small to let a real offender
 * through -- the trade that prompted this whole guard sat at 0.954.
 */
const RATIO_EPSILON = 1e-9;

export interface RiskRewardAssessment {
  ok: boolean;
  /** Present only when both an SL and a TP were set and both sit on valid sides of the entry. */
  ratio?: number;
  riskDistance?: number;
  rewardDistance?: number;
  /** Human-readable, suitable for showing the trader verbatim. */
  reason?: string;
}

function isLongOrder(type: OrderRequest["type"]): boolean {
  return type === "buy" || type === "buy_limit" || type === "buy_stop";
}

/**
 * Checks an order's stop and target against its entry. Returns ok:true when there is nothing to
 * object to -- including when no SL or no TP is set, since enforcing their PRESENCE is
 * risk-settings' job (slMode/tpMode), not this module's.
 */
export function assessRiskReward(order: OrderRequest, entryPrice: number, minRatio = MIN_RISK_REWARD_RATIO): RiskRewardAssessment {
  const { sl, tp } = order;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return { ok: true };
  const long = isLongOrder(order.type);

  // Sanity first: a stop on the wrong side of entry is not a stop at all -- for a BUY it would sit
  // ABOVE the entry, so it fills instantly for a guaranteed loss. Same for a target on the wrong
  // side, which would fill instantly for a guaranteed gain the broker will simply reject. Neither
  // was checked anywhere before this.
  if (sl !== undefined) {
    const slOnWrongSide = long ? sl >= entryPrice : sl <= entryPrice;
    if (slOnWrongSide) {
      return {
        ok: false,
        reason: `the stop loss (${sl}) is on the wrong side of the ${long ? "BUY" : "SELL"} entry (${entryPrice}) -- it would trigger immediately for a guaranteed loss`,
      };
    }
  }
  if (tp !== undefined) {
    const tpOnWrongSide = long ? tp <= entryPrice : tp >= entryPrice;
    if (tpOnWrongSide) {
      return {
        ok: false,
        reason: `the take profit (${tp}) is on the wrong side of the ${long ? "BUY" : "SELL"} entry (${entryPrice})`,
      };
    }
  }

  // The ratio itself needs both legs. With only one set there is no ratio to judge, and refusing
  // on that basis would block every trade the trader deliberately runs without a fixed target.
  if (sl === undefined || tp === undefined) return { ok: true };

  const riskDistance = Math.abs(entryPrice - sl);
  const rewardDistance = Math.abs(tp - entryPrice);
  if (riskDistance <= 0) return { ok: true }; // isSlTooTight owns the zero/near-zero-stop case
  const ratio = rewardDistance / riskDistance;

  if (ratio < minRatio - RATIO_EPSILON) {
    return {
      ok: false,
      ratio,
      riskDistance,
      rewardDistance,
      // Real bug fixed (the trader: "it should obey the settings own"). This text was written when
      // the floor was hardcoded at 1.0, so it always explained the refusal as "risking more than
      // you stand to make" -- which is simply FALSE once the trader raises the floor. A 1.5:1
      // trade refused against a 2:1 setting does not risk more than it makes, and telling the
      // model that invites it to argue with a number it can see is wrong, or to nudge the target
      // until the sentence stops being untrue. The refusal now names the configured floor, which
      // is the actual reason, and only adds the break-even point when it genuinely applies.
      reason:
        `risk:reward is ${ratio.toFixed(2)}:1, below your configured minimum of ${minRatio}:1 -- the stop risks ` +
        `${riskDistance.toFixed(0)} points to gain ${rewardDistance.toFixed(0)}` +
        (ratio < 1 ? ". Risking more than the trade stands to make needs a >50% win rate just to break even" : ""),
    };
  }
  return { ok: true, ratio, riskDistance, rewardDistance };
}

/**
 * Real feature (the trader, explicit: "the risk reward is possible make it settable"). The floor
 * is a strategy preference, not a universal truth -- a scalper may genuinely want 1:1 while a
 * swing trader wants 1:2 or better -- so it is persisted per user, read fresh on every check, in
 * exactly the same file-backed shape as every other real setting in this package.
 *
 * MIN_RISK_REWARD_RATIO above stays as the DEFAULT only: never risk more than you stand to gain.
 */
export const MIN_SETTABLE_RISK_REWARD = 0.1;
export const MAX_SETTABLE_RISK_REWARD = 100;

export class InvalidRiskRewardError extends Error {
  constructor(value: number) {
    super(
      `Minimum risk:reward must be a number between ${MIN_SETTABLE_RISK_REWARD} and ${MAX_SETTABLE_RISK_REWARD} -- got ${value}. ` +
        `Use 1 to mean "never risk more than the trade stands to gain", 2 to require a trade to pay double what it risks.`
    );
    this.name = "InvalidRiskRewardError";
  }
}

function riskRewardPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "risk-reward.json");
}

/** The user's own configured floor, or the default when they have never set one. */
export function getMinRiskReward(userId: string): number {
  const path = riskRewardPath(userId);
  if (!existsSync(path)) return MIN_RISK_REWARD_RATIO;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { minRiskReward?: number };
    const value = parsed.minRiskReward;
    // A corrupt or out-of-range file must never silently disable the guard, nor throw inside a
    // trading cycle -- fall back to the safe default instead.
    return typeof value === "number" && Number.isFinite(value) && value >= MIN_SETTABLE_RISK_REWARD && value <= MAX_SETTABLE_RISK_REWARD
      ? value
      : MIN_RISK_REWARD_RATIO;
  } catch {
    return MIN_RISK_REWARD_RATIO;
  }
}

export function setMinRiskReward(userId: string, value: number): { minRiskReward: number } {
  if (!Number.isFinite(value) || value < MIN_SETTABLE_RISK_REWARD || value > MAX_SETTABLE_RISK_REWARD) {
    throw new InvalidRiskRewardError(value);
  }
  const previous = getMinRiskReward(userId);
  const path = riskRewardPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify({ minRiskReward: value }, null, 2), "utf8");
  appendSettingsLogEntry(userId, "minRiskReward", previous, value);
  return { minRiskReward: value };
}

/** Convenience for callers that just want "check this order against THIS user's own floor". */
export function assessRiskRewardForUser(userId: string, order: OrderRequest, entryPrice: number): RiskRewardAssessment {
  return assessRiskReward(order, entryPrice, getMinRiskReward(userId));
}
