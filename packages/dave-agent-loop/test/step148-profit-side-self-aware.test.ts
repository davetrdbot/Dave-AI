import assert from "node:assert/strict";
import {
  advanceMonitor,
  isRanging,
  PROFIT_STABLE_MS,
  QUICK_PROFIT_CHECK_MS,
  PROFIT_DROP_AFTER_MS,
  PEAK_PULLBACK_FRACTION,
  REARM_COOLDOWN_MS,
  RANGE_WINDOW_MS,
  MAX_SAMPLES,
  REASON_NOT_RECORDED,
  type TradeMonitor,
  type PositionObservation,
  type MonitorAlertKind,
} from "../src/trade-monitor-store.js";
import { buildMonitorAlert } from "../src/trade-monitor-sweep.js";

/**
 * The trader's five profit-side self-aware checks.
 *
 * The monitor only ever watched the DOWNSIDE -- losing, deep loss, recovery. A trade that went
 * green and then quietly handed the whole profit back produced no signal at all, which is what
 * these fix. Time is injected throughout, so every threshold is asserted at its real boundary
 * rather than by sleeping.
 */

const MIN = 60_000;
const T0 = 1_700_000_000_000;

/** A buy at 100 with its stop at 90 -- risk of 10, so every band scales off a round number. */
function obs(over: Partial<PositionObservation> = {}): PositionObservation {
  return { ticket: "T1", symbol: "VOL_80", direction: "buy", openPrice: 100, sl: 90, currentPrice: 100, pnl: 0, reason: "bullish continuation", ...over };
}

/** Drives a series of observations through the pure state machine, collecting what fired when. */
function drive(steps: { at: number; price?: number; pnl: number }[]): { monitor: TradeMonitor; fired: { at: number; kind: MonitorAlertKind }[] } {
  let monitor: TradeMonitor | undefined;
  const fired: { at: number; kind: MonitorAlertKind }[] = [];
  for (const s of steps) {
    const res = advanceMonitor(monitor, obs({ price: s.price, currentPrice: s.price ?? 100, pnl: s.pnl }), s.at);
    monitor = res.monitor;
    for (const a of res.alerts) fired.push({ at: s.at, kind: a.kind });
  }
  return { monitor: monitor as TradeMonitor, fired };
}

const kinds = (f: { kind: MonitorAlertKind }[]) => f.map((x) => x.kind);

console.log("=== The five profit-side self-aware checks ===\n");

console.log("[1] Profit stability fires once at ~5 min in profit, not before...\n");
{
  const { fired } = drive([
    { at: T0, price: 103, pnl: 3 }, // green from the first sighting -> clock starts at T0
    { at: T0 + 4 * MIN, price: 103, pnl: 3 },
    { at: T0 + PROFIT_STABLE_MS - 1000, price: 103, pnl: 3 },
    { at: T0 + PROFIT_STABLE_MS + 1000, price: 103, pnl: 3 },
    { at: T0 + PROFIT_STABLE_MS + 2 * MIN, price: 103, pnl: 3 },
  ]);
  const hits = fired.filter((f) => f.kind === "profitStable");
  assert.equal(hits.length, 1, `exactly once, got ${hits.length}`);
  assert.ok(hits[0].at >= T0 + PROFIT_STABLE_MS, "never before the threshold");
  console.log(`    confirmed: fired once at +${Math.round((hits[0].at - T0) / MIN)} min, silent before`);
}

console.log("\n[2] The profit clock starts when it goes green, not when the trade opened...\n");
{
  // 8 minutes underwater first; the profit checks must measure from the green crossing.
  const greenAt = T0 + 8 * MIN;
  const { fired } = drive([
    { at: T0, price: 100, pnl: 0 },
    { at: T0 + 4 * MIN, price: 97, pnl: -3 },
    { at: greenAt, price: 102, pnl: 2 },
    { at: greenAt + PROFIT_STABLE_MS - 1000, price: 102, pnl: 2 },
    { at: greenAt + PROFIT_STABLE_MS + 1000, price: 102, pnl: 2 },
  ]);
  const hit = fired.find((f) => f.kind === "profitStable")!;
  assert.ok(hit.at >= greenAt + PROFIT_STABLE_MS, "measured from the green crossing, not from open");
  console.log("    confirmed: an 8-min losing spell doesn't count toward 'in profit for 5 min'");
}

console.log("\n[3] Dropping out of profit re-arms the checks for the next green run...\n");
{
  const { monitor } = drive([
    { at: T0, price: 103, pnl: 3 },
    { at: T0 + MIN, price: 103, pnl: 3 },
    { at: T0 + PROFIT_STABLE_MS + 2 * MIN, price: 103, pnl: 3 },
    { at: T0 + PROFIT_STABLE_MS + 3 * MIN, price: 98, pnl: -2 },
  ]);
  assert.equal(monitor.profitStartedAt, undefined, "profit clock cleared when it went red");
  assert.equal(monitor.alerts.profitStable, false, "latch re-armed");
  assert.equal(monitor.alerts.quickProfitCheck, false, "…and so is the quick check");
  console.log("    confirmed: a trade that dips and recovers can genuinely report twice");
}

console.log("\n[4] Quick profit check fires later than stability -- two distinct moments...\n");
{
  const { fired } = drive([
    { at: T0, price: 103, pnl: 3 },
    { at: T0 + 30_000, price: 103, pnl: 3 },
    { at: T0 + PROFIT_STABLE_MS + 30_000, price: 103, pnl: 3 },
    { at: T0 + QUICK_PROFIT_CHECK_MS + 60_000, price: 103, pnl: 3 },
  ]);
  const stable = fired.find((f) => f.kind === "profitStable")!;
  const quick = fired.find((f) => f.kind === "quickProfitCheck")!;
  assert.ok(quick.at > stable.at, "the quick check lands after stability, never on top of it");
  assert.equal(fired.filter((f) => f.kind === "quickProfitCheck").length, 1, "once only");
  console.log(`    confirmed: stability at +${Math.round((stable.at - T0) / MIN)}min, quick check at +${Math.round((quick.at - T0) / MIN)}min`);
}

console.log("\n[5] Profit reduction needs a REAL drop after 10 min, not one sweep's jitter...\n");
{
  // Peaks at 10, wobbles to 9.7 (3% -- noise), then genuinely falls to 6.
  const { fired } = drive([
    { at: T0, price: 105, pnl: 5 }, // green from the start -> the 10-min profit gate is real
    { at: T0 + 30_000, price: 105, pnl: 5 },
    { at: T0 + PROFIT_DROP_AFTER_MS + MIN, price: 110, pnl: 10 },
    { at: T0 + PROFIT_DROP_AFTER_MS + 2 * MIN, price: 109.7, pnl: 9.7 },
    { at: T0 + PROFIT_DROP_AFTER_MS + 3 * MIN, price: 106, pnl: 6 },
  ]);
  const drops = fired.filter((f) => f.kind === "profitDrop");
  assert.equal(drops.length, 1, `a 3% wobble must not fire; only the real 40% give-back, got ${drops.length}`);
  assert.equal(drops[0].at, T0 + PROFIT_DROP_AFTER_MS + 3 * MIN, "fired on the genuine drop");
  console.log("    confirmed: noise ignored, the real give-back caught");
}

console.log("\n[6] Peak pullback tracks the high-water mark and respects its cooldown...\n");
{
  const { monitor, fired } = drive([
    { at: T0, price: 101, pnl: 1 },
    { at: T0 + MIN, price: 120, pnl: 20 },
    { at: T0 + 2 * MIN, price: 112, pnl: 12 }, // 40% off the peak -> fires
    { at: T0 + 3 * MIN, price: 111, pnl: 11 }, // still down, but inside the cooldown
    { at: T0 + 2 * MIN + REARM_COOLDOWN_MS + MIN, price: 108, pnl: 8 }, // cooldown passed -> fires again
  ]);
  assert.equal(monitor.bestPnl, 20, "peak tracked");
  assert.equal(monitor.bestPnlAt, T0 + MIN, "…and when it happened");
  const pulls = fired.filter((f) => f.kind === "peakPullback");
  assert.equal(pulls.length, 2, `two real events, not one per sweep -- got ${pulls.length}`);
  assert.ok(pulls[1].at - pulls[0].at >= REARM_COOLDOWN_MS, "cooldown genuinely enforced");
  console.log(`    confirmed: peak ${monitor.bestPnl}, 2 alerts ${Math.round((pulls[1].at - pulls[0].at) / MIN)}min apart`);
}

console.log("\n[7] A tiny peak never triggers a pullback alert...\n");
{
  const { fired } = drive([
    { at: T0, price: 100.1, pnl: 0.1 },
    { at: T0 + MIN, price: 100.5, pnl: 0.5 },
    { at: T0 + 2 * MIN, price: 100.1, pnl: 0.1 }, // 80% off a peak of 0.5 -- but 0.5 is nothing
  ]);
  assert.equal(kinds(fired).includes("peakPullback"), false, "a peak of 0.5 is not a peak worth alerting on");
  console.log("    confirmed: +0.50 peaks don't generate pullback noise");
}

console.log("\n[8] RANGE: genuine chop is caught...\n");
{
  // Risk is 10, band allows 6. Oscillate 99<->103 for a full window, crossing the midline often.
  const steps: { at: number; price: number; pnl: number }[] = [];
  for (let i = 0; i <= 24; i++) {
    const price = i % 2 === 0 ? 99 : 103;
    steps.push({ at: T0 + i * 30_000, price, pnl: price - 100 });
  }
  const { monitor, fired } = drive(steps);
  assert.ok(isRanging(monitor, steps[steps.length - 1].at), "sustained back-and-forth inside the band IS a range");
  assert.ok(kinds(fired).includes("range"), "…and it genuinely fires");
  console.log(`    confirmed: 12 min of 99<->103 oscillation detected as a range`);
}

console.log("\n[9] RANGE: a trend does NOT count, even a choppy one...\n");
{
  // Climbs steadily 100 -> 112 with jitter. Never a range: it went somewhere.
  const steps: { at: number; price: number; pnl: number }[] = [];
  for (let i = 0; i <= 24; i++) {
    const price = 100 + i * 0.5 + (i % 2 === 0 ? 0.3 : -0.3);
    steps.push({ at: T0 + i * 30_000, price, pnl: price - 100 });
  }
  const { monitor, fired } = drive(steps);
  assert.equal(isRanging(monitor, steps[steps.length - 1].at), false, "a climbing market is not a range");
  assert.equal(kinds(fired).includes("range"), false, "and must not alert");
  console.log("    confirmed: a jittery uptrend is not mistaken for chop");
}

console.log("\n[10] RANGE: one wobble is not a range, and neither is a short history...\n");
{
  const short = drive([
    { at: T0, price: 100, pnl: 0 },
    { at: T0 + 30_000, price: 101, pnl: 1 },
    { at: T0 + 60_000, price: 99, pnl: -1 },
    { at: T0 + 90_000, price: 101, pnl: 1 },
  ]);
  assert.equal(isRanging(short.monitor, T0 + 90_000), false, "90 seconds is not 'an extended period'");
  // A full window that drifts through the band crosses the midline once -- not chop.
  const drift: { at: number; price: number; pnl: number }[] = [];
  for (let i = 0; i <= 24; i++) drift.push({ at: T0 + i * 30_000, price: 99 + i * 0.1, pnl: i * 0.1 - 1 });
  const d = drive(drift);
  assert.equal(isRanging(d.monitor, drift[drift.length - 1].at), false, "a slow drift crosses once -- not back-and-forth");
  console.log(`    confirmed: <${RANGE_WINDOW_MS / MIN}min history and slow drift both rejected`);
}

console.log("\n[11] The sample history is bounded -- an all-day trade can't grow the store...\n");
{
  const steps: { at: number; price: number; pnl: number }[] = [];
  for (let i = 0; i < 300; i++) steps.push({ at: T0 + i * 30_000, price: 100 + (i % 3), pnl: i % 3 });
  const { monitor } = drive(steps);
  assert.equal(monitor.samples!.length, MAX_SAMPLES, `capped at ${MAX_SAMPLES}, got ${monitor.samples!.length}`);
  assert.equal(monitor.samples![monitor.samples!.length - 1].at, T0 + 299 * 30_000, "newest kept, oldest dropped");
  console.log(`    confirmed: 300 sweeps -> ${monitor.samples!.length} samples retained`);
}

console.log("\n[12] Every message carries the fields the spec asks for...\n");
{
  // Sampled right through to `now`, the way a real 30s sweep does -- momentum is read off the
  // recent history, so an alert built 10 minutes after the last observation genuinely has nothing
  // to report and says so.
  const { monitor } = drive([
    { at: T0, price: 101, pnl: 1 },
    { at: T0 + MIN, price: 120, pnl: 20 },
    { at: T0 + 2 * MIN, price: 112, pnl: 12 },
    { at: T0 + 10 * MIN, price: 113, pnl: 13 },
    { at: T0 + 11 * MIN, price: 112.5, pnl: 12.5 },
    { at: T0 + 12 * MIN, price: 112, pnl: 12 },
  ]);
  monitor.tp = 110;
  const now = T0 + 12 * MIN;
  const msg = (k: MonitorAlertKind) => buildMonitorAlert({ kind: k, monitor }, now);

  for (const k of ["profitStable", "profitDrop", "peakPullback", "range", "quickProfitCheck"] as MonitorAlertKind[]) {
    assert.match(msg(k), /📌 Original idea: bullish continuation/, `${k} must quote the original idea`);
  }
  assert.match(msg("profitDrop"), /Current profit: \+12\.00/);
  assert.match(msg("profitDrop"), /Previous peak: \+20\.00/);
  assert.match(msg("profitDrop"), /Reduction: -8\.00/);
  assert.match(msg("peakPullback"), /Peak profit: \+20\.00/);
  assert.match(msg("peakPullback"), /Pullback: -8\.00/);
  assert.match(msg("range"), /RANGE DETECTED/);
  assert.match(msg("range"), /Current trade: BUY VOL_80/);
  assert.match(msg("range"), /Trade duration: 12 min/);
  assert.match(msg("quickProfitCheck"), /Target: 10\.0%/, "target derived from the real TP against entry");
  assert.match(msg("quickProfitCheck"), /Momentum: (building|fading|flat)/);
  console.log("    confirmed: current/peak/reduction/duration/target/momentum all present and real");
}

console.log("\n[13] A trade with no TP says so rather than inventing a target...\n");
{
  const { monitor } = drive([{ at: T0, price: 101, pnl: 1 }, { at: T0 + MIN, price: 105, pnl: 5 }]);
  monitor.tp = undefined;
  assert.match(buildMonitorAlert({ kind: "quickProfitCheck", monitor }, T0 + 11 * MIN), /Target: none set/);
  console.log("    confirmed: no TP -> 'none set', never a fabricated percentage");
}

console.log("\n[14] The reason placeholder can never overwrite a real reason...\n");
{
  const first = advanceMonitor(undefined, obs({ reason: REASON_NOT_RECORDED }), T0);
  assert.equal(first.monitor.reason, REASON_NOT_RECORDED, "starts blank when the journal hasn't landed yet");
  const second = advanceMonitor(first.monitor, obs({ reason: "swept the low and reclaimed" }), T0 + 30_000);
  assert.equal(second.monitor.reason, "swept the low and reclaimed", "a real reason arriving later is adopted");
  const third = advanceMonitor(second.monitor, obs({ reason: REASON_NOT_RECORDED }), T0 + 60_000);
  assert.equal(third.monitor.reason, "swept the low and reclaimed", "and can never be clobbered back to the placeholder");
  console.log("    confirmed: placeholder in -> real reason wins, and sticks");
}

console.log("\n=== ALL ASSERTIONS PASSED ===");
process.exit(0);
