/**
 * Real pre-trade account-awareness gate (prompts/trading.md "Account awareness" section):
 * before any real trade, Dave is instructed to look at live balance, leverage, and existing open
 * positions to avoid over-trading/over-leveraging. This module is the actual runtime enforcement
 * behind that instruction, not just prose -- a pure function (no I/O of its own) so it can be
 * called from wherever a real account snapshot + open-position count is already available
 * (dave-agent-loop's autonomous tick and its wrapped trade_execute tool both have one; dave-trading
 * itself can't reach the EA-bridge stores directly without a package cycle, see
 * analysis-source.ts's own note on the same constraint).
 */

export interface AccountAwarenessInput {
  balance: number;
  freeMargin?: number;
  leverage?: number;
  openPositionsCount: number;
}

export interface AccountAwarenessLimits {
  maxOpenTrades?: number;
}

export interface AccountAwarenessResult {
  ok: boolean;
  reason?: string;
}

/** Free margin below this fraction of balance is treated as genuinely over-leveraged -- opening
 *  another position risks a margin call regardless of what any single setting says. */
const MIN_FREE_MARGIN_PCT = 10;

export function evaluateAccountAwareness(input: AccountAwarenessInput, limits: AccountAwarenessLimits): AccountAwarenessResult {
  if (limits.maxOpenTrades !== undefined && input.openPositionsCount >= limits.maxOpenTrades) {
    return {
      ok: false,
      reason:
        `Already at the user's max open trades limit (${input.openPositionsCount}/${limits.maxOpenTrades}) -- ` +
        `this would be over-trading the account. Do not open another position until one closes or the user raises the limit.`,
    };
  }

  if (input.balance > 0 && input.freeMargin !== undefined) {
    const freeMarginPct = (input.freeMargin / input.balance) * 100;
    if (freeMarginPct < MIN_FREE_MARGIN_PCT) {
      return {
        ok: false,
        reason:
          `Free margin is critically low (${freeMarginPct.toFixed(1)}% of balance, leverage ${input.leverage !== undefined ? `1:${input.leverage}` : "unknown"}) -- ` +
          `the account is already over-leveraged. Opening another position here risks a margin call. Stand down or reduce exposure instead of adding size.`,
      };
    }
  }

  return { ok: true };
}
