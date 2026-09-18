import assert from "node:assert/strict";
import type { TradeExecutor } from "../src/trade-executor.js";
import type { OrderRequest } from "../src/order-types.js";
import { tradeExecuteWithMarginRetry, InsufficientMarginError, isMarginRejection, ABSOLUTE_MIN_LOTS } from "../src/margin-aware-execute.js";

/**
 * Real bug fixed, caught in the trader's own production logs the moment the autonomous loop
 * finally started working end to end. The very first trade Dave ever tried to place:
 *
 *   11:01:33  BOOM_100: model decided BUY (confidence 62%) -- all six timeframes STRONG_BULL AGREE
 *   11:01:53  Error: failed: not enough money
 *
 * Dave sizes his own lots against a balance he can see, but the margin a lot actually COSTS
 * depends on contract size and leverage that only MT5 knows and that he is never told. On a $100
 * account trading synthetic indices priced in the hundreds of thousands, that guess is
 * unaffordable every time -- so this would have repeated on every single good setup. A bot that
 * analyses perfectly and can never place a trade.
 */

console.log("=== Real proof: an unaffordable trade is re-sized until the broker accepts it ===\n");

/** A broker that refuses anything above `affordableLots` with the EXACT wording the trader's own
 *  Headway/MT5 bridge produced live -- not an invented error string. */
function brokerWithMargin(affordableLots: number): { executor: TradeExecutor; attempts: number[] } {
  const attempts: number[] = [];
  const executor: TradeExecutor = {
    openOrder: async (order: OrderRequest) => {
      attempts.push(order.lots);
      if (order.lots > affordableLots) throw new Error("failed: not enough money");
      return { ticket: `T-${order.lots}` };
    },
    modifyOrder: async () => {},
    closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
    deletePendingOrder: async () => {},
    listOpenPositions: async () => [],
    listPendingOrders: async () => [],
  };
  return { executor, attempts };
}

const baseOrder: OrderRequest = { symbol: "BOOM_100", type: "buy", lots: 1.0 };

async function main() {
  console.log("[1] The real failure: the broker's own 'not enough money' is recognised as retryable...\n");
  assert.ok(isMarginRejection(new Error("failed: not enough money")), "the trader's REAL live broker wording must be recognised");
  assert.ok(isMarginRejection(new Error("No money")), "MT5's own retcode wording must be recognised too");
  assert.ok(!isMarginRejection(new Error("market is closed")), "a non-margin error must NOT be retried at a smaller size");
  console.log("    confirmed: margin rejections retry, everything else stays untouched");

  console.log("\n[2] An oversized trade genuinely gets placed at a size the account can carry...\n");
  const { executor, attempts } = brokerWithMargin(0.12);
  const placed = await tradeExecuteWithMarginRetry(executor, baseOrder);
  console.log(`    real sizes attempted: ${JSON.stringify(attempts)}`);
  assert.deepEqual(attempts, [1, 0.5, 0.25, 0.12], "must step DOWN from what Dave asked for, halving each time");
  assert.equal(placed.placedLots, 0.12, "the trade must genuinely go through at the largest affordable size");
  assert.equal(placed.requestedLots, 1.0, "the original request is kept, so the trader can be told what changed");
  assert.ok(placed.reducedForMargin, "the trade must be flagged as re-sized, never silently shrunk");
  console.log(`    confirmed: placed ${placed.placedLots} lots (Dave wanted ${placed.requestedLots}) -- ticket ${placed.ticket}`);

  console.log("\n[3] An affordable trade is placed first time, with no meddling at all...\n");
  const fine = brokerWithMargin(5);
  const placedFine = await tradeExecuteWithMarginRetry(fine.executor, baseOrder);
  assert.deepEqual(fine.attempts, [1], "an affordable order must go out exactly once, at exactly the requested size");
  assert.equal(placedFine.reducedForMargin, false, "an untouched trade must never be reported as re-sized");
  console.log("    confirmed: one attempt, size unchanged, nothing reported to the trader");

  console.log("\n[4] A genuinely broke account fails honestly, rather than looping forever...\n");
  const broke = brokerWithMargin(0);
  await assert.rejects(
    () => tradeExecuteWithMarginRetry(broke.executor, baseOrder),
    (err: unknown) => {
      assert.ok(err instanceof InsufficientMarginError, "must be the specific typed error the tick shows the trader");
      assert.match(err.message, /cannot afford this trade at any size/, "the message must be honest about what happened");
      return true;
    },
    "an account that cannot afford even the minimum must fail clearly"
  );
  assert.equal(broke.attempts[broke.attempts.length - 1], ABSOLUTE_MIN_LOTS, `must genuinely try the ${ABSOLUTE_MIN_LOTS} floor before giving up`);
  assert.ok(broke.attempts.length <= 6, `must not retry forever -- real attempts: ${broke.attempts.length}`);
  console.log(`    real sizes attempted before giving up: ${JSON.stringify(broke.attempts)}`);

  console.log("\n[5] A non-margin broker error is NEVER quietly retried smaller -- it surfaces as-is...\n");
  let sent = 0;
  const badSymbol: TradeExecutor = {
    openOrder: async () => {
      sent++;
      throw new Error("unknown symbol BOOM_100");
    },
    modifyOrder: async () => {},
    closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
    deletePendingOrder: async () => {},
    listOpenPositions: async () => [],
    listPendingOrders: async () => [],
  };
  await assert.rejects(() => tradeExecuteWithMarginRetry(badSymbol, baseOrder), /unknown symbol/, "a real problem must reach the caller unchanged");
  assert.equal(sent, 1, "a non-margin failure must be attempted exactly once, not re-sent at other sizes");
  console.log("    confirmed: 'unknown symbol' surfaced untouched after exactly one attempt");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
