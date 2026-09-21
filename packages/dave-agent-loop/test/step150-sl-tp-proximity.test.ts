import assert from "node:assert/strict";
import {
  advanceMonitor,
  tpProgress,
  slProgress,
  SL_NEAR_PROGRESS,
  SL_CRITICAL_PROGRESS,
  TP_NEAR_PROGRESS,
  type TradeMonitor,
  type PositionObservation,
  type MonitorAlertKind,
} from "../src/trade-monitor-store.js";
import { buildMonitorAlert, alertCategoryOf } from "../src/trade-monitor-sweep.js";
import { ALERT_CATEGORIES } from "@dave/trading";

/**
 * The trader: "when it's 89 percentage near the SL, and 95 it should alert, and when a trade is
 * 85 near the TP too".
 *
 * Three escalating proximity warnings. The monitor could already see progress toward the STOP (the
 * settable deep-loss level, default 50%) but had no late stages and -- more importantly -- no
 * concept of progress toward the TARGET at all, so a trade could arrive at 99% of its take profit
 * in complete silence.
 */

const T0 = 1_700_000_000_000;
const MIN = 60_000;

/** BUY at 100, stop 90, target 110 -- so 1% of progress is 0.1 of price in either direction. */
function buy(price: number, pnl: number): PositionObservation {
  return { ticket: "B1", symbol: "VOL_80", direction: "buy", openPrice: 100, sl: 90, tp: 110, currentPrice: price, pnl, reason: "bullish continuation" };
}
/** SELL at 100, stop 110, target 90 -- the mirror, to prove direction is handled. */
function sell(price: number, pnl: number): PositionObservation {
  return { ticket: "S1", symbol: "CRASH_100", direction: "sell", openPrice: 100, sl: 110, tp: 90, currentPrice: price, pnl, reason: "swept the high" };
}

function drive(obss: { obs: PositionObservation; at: number }[]) {
  let monitor: TradeMonitor | undefined;
  const fired: { at: number; kind: MonitorAlertKind }[] = [];
  for (const step of obss) {
    const res = advanceMonitor(monitor, step.obs, step.at);
    monitor = res.monitor;
    for (const a of res.alerts) fired.push({ at: step.at, kind: a.kind });
  }
  return { monitor: monitor as TradeMonitor, fired };
}
const kinds = (f: { kind: MonitorAlertKind }[]) => f.map((x) => x.kind);

console.log("=== 89% / 95% to the stop, 85% to the target ===\n");

console.log("[1] The thresholds are the trader's own numbers...\n");
assert.equal(SL_NEAR_PROGRESS, 0.89);
assert.equal(SL_CRITICAL_PROGRESS, 0.95);
assert.equal(TP_NEAR_PROGRESS, 0.85);
console.log("    confirmed: 89% / 95% to SL, 85% to TP");

console.log("\n[2] TP progress is a real measure, and works on BOTH directions...\n");
{
  // Buy 100 -> 110: 108.5 is 85% of the way.
  assert.equal(tpProgress({ openPrice: 100, tp: 110 }, 108.5), 0.85);
  // Sell 100 -> 90: 91.5 is also 85% of the way. Both numerator and denominator flip sign.
  assert.equal(tpProgress({ openPrice: 100, tp: 90 }, 91.5), 0.85);
  assert.equal(tpProgress({ openPrice: 100, tp: 110 }, 95), 0, "moving AWAY from target clamps at 0, never negative");
  assert.equal(tpProgress({ openPrice: 100, tp: 110 }, 999), 1, "…and overshoot clamps at 1");
  assert.equal(tpProgress({ openPrice: 100, tp: undefined }, 105), undefined, "no TP -> no reading, never a guess");
  assert.equal(tpProgress({ openPrice: 100, tp: 100 }, 100), undefined, "a TP at entry is not a distance");
  console.log("    confirmed: symmetric on buy/sell, clamped, undefined when there is no TP");
}

console.log("\n[3] A BUY walking into its stop alerts at 89, then again at 95...\n");
{
  const { fired } = drive([
    { obs: buy(100, 0), at: T0 },
    { obs: buy(95, -5), at: T0 + MIN },      // 50% — the settable deep-loss level
    { obs: buy(91.5, -8.5), at: T0 + 2 * MIN }, // 85% — not yet
    { obs: buy(91.0, -9.0), at: T0 + 3 * MIN }, // 90% — slNear
    { obs: buy(90.4, -9.6), at: T0 + 4 * MIN }, // 96% — slCritical
  ]);
  const near = fired.filter((f) => f.kind === "slNear");
  const crit = fired.filter((f) => f.kind === "slCritical");
  assert.equal(near.length, 1, `89% must fire exactly once, got ${near.length}`);
  assert.equal(crit.length, 1, `95% must fire exactly once, got ${crit.length}`);
  assert.equal(near[0].at, T0 + 3 * MIN, "not at 85%, only once past 89%");
  assert.ok(crit[0].at > near[0].at, "95% comes after 89% -- they escalate, they don't replace");
  console.log("    confirmed: silent at 85%, fired at 90%, fired again at 96%");
}

console.log("\n[4] 89% firing does NOT suppress 95% -- both reach the trader...\n");
{
  // Straight from safe to 97% in one sweep: BOTH stages must still fire.
  const { fired } = drive([
    { obs: buy(100, 0), at: T0 },
    { obs: buy(90.3, -9.7), at: T0 + MIN },
  ]);
  assert.ok(kinds(fired).includes("slNear"), "the 89% stage still fires on a gap through it");
  assert.ok(kinds(fired).includes("slCritical"), "…and so does 95%");
  console.log("    confirmed: a fast move through both levels reports both");
}

console.log("\n[5] A SELL is measured correctly -- price rising is the danger side...\n");
{
  const { fired } = drive([
    { obs: sell(100, 0), at: T0 },
    { obs: sell(109.0, -9.0), at: T0 + MIN },  // 90% toward the 110 stop
    { obs: sell(109.6, -9.6), at: T0 + 2 * MIN }, // 96%
  ]);
  assert.ok(kinds(fired).includes("slNear"));
  assert.ok(kinds(fired).includes("slCritical"));
  assert.equal(slProgress({ openPrice: 100, sl: 110 }, 109), 0.9, "direction handled without a special case");
  console.log("    confirmed: a short approaching its stop upward is measured the same way");
}

console.log("\n[6] 85% toward TARGET alerts -- on both directions, and only once...\n");
{
  const b = drive([
    { obs: buy(100, 0), at: T0 },
    { obs: buy(108.0, 8), at: T0 + MIN },   // 80% — not yet
    { obs: buy(108.6, 8.6), at: T0 + 2 * MIN }, // 86% — fires
    { obs: buy(109.0, 9.0), at: T0 + 3 * MIN }, // 90% — must not re-nag
  ]);
  const hits = b.fired.filter((f) => f.kind === "tpNear");
  assert.equal(hits.length, 1, `once only, got ${hits.length}`);
  assert.equal(hits[0].at, T0 + 2 * MIN, "silent at 80%, fires past 85%");

  const s = drive([
    { obs: sell(100, 0), at: T0 },
    { obs: sell(91.4, 8.6), at: T0 + MIN }, // 86% toward the 90 target
  ]);
  assert.ok(kinds(s.fired).includes("tpNear"), "a short approaching its target downward fires too");
  console.log("    confirmed: fires once past 85% on both a long and a short");
}

console.log("\n[7] A trade with no TP never produces a target alert...\n");
{
  const noTp = { ...buy(109, 9), tp: undefined };
  const { fired } = drive([{ obs: { ...buy(100, 0), tp: undefined }, at: T0 }, { obs: noTp, at: T0 + MIN }]);
  assert.equal(kinds(fired).includes("tpNear"), false, "no TP means no distance to be 85% of");
  console.log("    confirmed: silent rather than inventing a target");
}

console.log("\n[8] A winner never trips a stop warning, and a loser never trips a target one...\n");
{
  const winner = drive([{ obs: buy(100, 0), at: T0 }, { obs: buy(109, 9), at: T0 + MIN }]);
  assert.equal(kinds(winner.fired).includes("slNear"), false);
  assert.equal(kinds(winner.fired).includes("slCritical"), false);
  const loser = drive([{ obs: buy(100, 0), at: T0 }, { obs: buy(91, -9), at: T0 + MIN }]);
  assert.equal(kinds(loser.fired).includes("tpNear"), false);
  console.log("    confirmed: the two sides never cross-fire");
}

console.log("\n[9] Each message states the real percentage AND the real level...\n");
{
  const { monitor } = drive([{ obs: buy(100, 0), at: T0 }, { obs: buy(90.4, -9.6), at: T0 + MIN }]);
  const msg = (k: MonitorAlertKind) => buildMonitorAlert({ kind: k, monitor }, T0 + 2 * MIN);
  assert.match(msg("slNear"), /89% of the way from entry to its stop \(90\)/);
  assert.match(msg("slCritical"), /95% of the way to its stop \(90\)/);
  assert.match(msg("slCritical"), /ABOUT TO BE STOPPED OUT/);
  assert.match(msg("tpNear"), /85% of the distance from entry to its take profit \(110\)/);
  assert.match(msg("tpNear"), /take partial profit|tighten the stop/);
  for (const k of ["slNear", "slCritical", "tpNear"] as MonitorAlertKind[]) {
    assert.match(msg(k), /📌 Original idea: bullish continuation/, `${k} must quote the original idea`);
  }
  console.log("    confirmed: real % + real price level + the original idea on all three");
}

console.log("\n[10] All three have their own on/off switch...\n");
{
  assert.equal(alertCategoryOf("slNear"), "sl_near");
  assert.equal(alertCategoryOf("slCritical"), "sl_critical");
  assert.equal(alertCategoryOf("tpNear"), "tp_near");
  for (const id of ["sl_near", "sl_critical", "tp_near"]) {
    assert.ok(ALERT_CATEGORIES.some((c) => c.id === id), `${id} must be a real, listed, togglable category`);
  }
  console.log(`    confirmed: 3 new switches, ${ALERT_CATEGORIES.length} categories total`);
}

console.log("\n=== ALL ASSERTIONS PASSED ===");
process.exit(0);
