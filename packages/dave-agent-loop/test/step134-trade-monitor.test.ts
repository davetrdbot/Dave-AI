import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { logTrade } from "@dave/feedback";

const workDir = mkdtempSync(join(tmpdir(), "dave-monitor-"));
process.env.DAVE_DATA_ROOT = workDir;

import type { PositionObservation } from "../src/trade-monitor-store.js";
const { advanceMonitor, LOSS_ALERT_5M_MS, LOSS_ALERT_10M_MS } = await import("../src/trade-monitor-store.js");
const { runTradeMonitorSweep, buildMonitorAlert } = await import("../src/trade-monitor-sweep.js");

/**
 * The Self-Aware Trade Monitor (trader spec): continuously watch each trade, know its original idea,
 * track its lifecycle, and alert -- quoting the idea -- when something important changes. This proves
 * the lifecycle state machine and the loss-duration / deep-loss / recovery alerts, all edge-triggered.
 */

const USER = "user-monitor-1";
const t0 = 1_000_000_000_000;
// A long: entry 100, SL 90. price 95 = halfway to stop (deep); price < 100 = losing.
function obs(over: Partial<PositionObservation> = {}): PositionObservation {
  return { ticket: "T1", symbol: "VOL_80", direction: "buy", openPrice: 100, sl: 90, tp: 130, reason: "Swept the low, bullish FVG reclaim.", ...over };
}

console.log("=== Self-Aware Trade Monitor: lifecycle + loss-duration + recovery ===\n");

try {
  console.log("[1] ENTRY -> LOSING, and the loss clock starts...\n");
  let r = advanceMonitor(undefined, obs({ currentPrice: 98, pnl: -2 }), t0);
  assert.equal(r.monitor.state, "losing");
  assert.equal(r.monitor.lossStartedAt, t0, "the loss clock starts when it first goes red");
  assert.equal(r.alerts.length, 0, "no duration alert yet -- it just went into loss");
  console.log("    confirmed: state=losing, loss clock set, no premature alert");

  console.log("\n[2] ~5 min in loss -> flash alert ONCE, quoting the original idea...\n");
  r = advanceMonitor(r.monitor, obs({ currentPrice: 98, pnl: -2 }), t0 + LOSS_ALERT_5M_MS);
  const five = r.alerts.filter((a) => a.kind === "loss5m");
  assert.equal(five.length, 1, "the 5-minute loss alert must fire once");
  const msg = buildMonitorAlert(five[0], t0 + LOSS_ALERT_5M_MS);
  assert.match(msg, /Swept the low, bullish FVG reclaim\./, "the alert must quote the original idea");
  // Another sweep still inside the window must NOT re-fire it.
  r = advanceMonitor(r.monitor, obs({ currentPrice: 98, pnl: -2 }), t0 + LOSS_ALERT_5M_MS + 30_000);
  assert.equal(r.alerts.filter((a) => a.kind === "loss5m").length, 0, "the 5-min alert must never re-fire");
  console.log(`    real alert:\n      ${msg.split("\n").join("\n      ")}`);

  console.log("\n[3] ~10 min in loss -> escalation alert ONCE...\n");
  r = advanceMonitor(r.monitor, obs({ currentPrice: 98, pnl: -2 }), t0 + LOSS_ALERT_10M_MS);
  assert.equal(r.alerts.filter((a) => a.kind === "loss10m").length, 1, "the 10-minute escalation must fire once");
  console.log("    confirmed: escalation at 10 min, edge-triggered");

  console.log("\n[4] DEEP LOSS: past halfway to the stop fires the deep-loss alert once...\n");
  r = advanceMonitor(r.monitor, obs({ currentPrice: 95, pnl: -5 }), t0 + LOSS_ALERT_10M_MS + 60_000); // slProgress 0.5
  assert.equal(r.monitor.state, "deep_loss");
  assert.equal(r.alerts.filter((a) => a.kind === "deepLoss").length, 1, "deep loss must fire once at halfway to stop");
  console.log("    confirmed: state=deep_loss, one deep-loss alert");

  console.log("\n[5] RECOVERY: after a prolonged loss, back to profit fires a recovery alert...\n");
  r = advanceMonitor(r.monitor, obs({ currentPrice: 101, pnl: 3 }), t0 + LOSS_ALERT_10M_MS + 120_000);
  assert.equal(r.alerts.filter((a) => a.kind === "recovery").length, 1, "recovery after prolonged loss must be announced");
  assert.equal(r.monitor.state, "profit", "and it ends in profit");
  assert.match(buildMonitorAlert({ kind: "recovery", monitor: r.monitor }, t0), /climbed back to profit/i);
  const states = r.monitor.history.map((h) => h.state);
  assert.ok(states.includes("entry") && states.includes("losing") && states.includes("deep_loss") && states.includes("recovery") && states.includes("profit"),
    `the full lifecycle story must be recorded, got ${states.join(" -> ")}`);
  console.log(`    lifecycle recorded: ${states.join(" -> ")}`);

  console.log("\n[6] Latches reset on profit, so a FRESH dip later re-arms the loss alerts...\n");
  r = advanceMonitor(r.monitor, obs({ currentPrice: 98, pnl: -2 }), t0 + 3_600_000); // new dip an hour later
  assert.equal(r.monitor.lossStartedAt, t0 + 3_600_000, "the loss clock restarts for the new dip");
  r = advanceMonitor(r.monitor, obs({ currentPrice: 98, pnl: -2 }), t0 + 3_600_000 + LOSS_ALERT_5M_MS);
  assert.equal(r.alerts.filter((a) => a.kind === "loss5m").length, 1, "a genuinely new loss period must be able to alert again");
  console.log("    confirmed: profit resets the latches; a new loss re-arms them");

  console.log("\n[7] A winning trade never fires a loss alert (directional, not abs)...\n");
  let w = advanceMonitor(undefined, obs({ ticket: "T2", currentPrice: 120, pnl: 20 }), t0);
  assert.equal(w.monitor.state, "profit");
  w = advanceMonitor(w.monitor, obs({ ticket: "T2", currentPrice: 125, pnl: 25 }), t0 + LOSS_ALERT_10M_MS);
  assert.equal(w.alerts.length, 0, "a trade that's been winning the whole time must never get a loss alert");
  console.log("    confirmed: a winner stays silent");

  console.log("\n[8] END TO END through the EA snapshot: alert sends, then CLOSE finalizes...\n");
  const db = new DaveDatabase(join(workDir, "dave.db"));
  logTrade(db, USER, { ticket: "T9", symbol: "CRASH_200", direction: "sell", entryPrice: 600000, sl: 610000, tp: 570000, reasoning: ["Deep bear OB rejection."], confluenceScore: 72 } as never);
  const eaDir = join(workDir, "data", "ea-bridge", USER);
  mkdirSync(eaDir, { recursive: true });
  const setPos = (positions: unknown[]) => writeFileSync(join(eaDir, "last-known-state.json"), JSON.stringify({ positions, pendingOrders: [] }), "utf8");
  // short: entry 600000, sl 610000; price 605000 = halfway to stop (deep), losing
  setPos([{ ticket: "T9", symbol: "CRASH_200", type: "sell", lots: 0.02, openPrice: 600000, sl: 610000, tp: 570000, currentPrice: 605000, pnl: -8 }]);
  const sent: string[] = [];
  const fired = await runTradeMonitorSweep({ db, userId: USER, notify: async (t) => void sent.push(t) }, t0);
  assert.ok(fired.some((a) => a.kind === "deepLoss"), "a short halfway to its stop must fire deep loss");
  assert.match(sent.join("\n"), /Deep bear OB rejection\./, "the alert pulls the real reason from the trade journal");
  // ticket closes:
  setPos([]);
  await runTradeMonitorSweep({ db, userId: USER, notify: async () => {} }, t0 + 60_000);
  const { readMonitors } = await import("../src/trade-monitor-store.js");
  const closed = readMonitors(USER).find((m) => m.ticket === "T9");
  assert.equal(closed?.state, "closed", "when the ticket vanishes the monitor closes");
  assert.ok(closed?.history.some((h) => h.state === "closed"), "and records the CLOSED transition with a timestamp");
  console.log("    confirmed: real EA read -> deep-loss alert with journal reason -> CLOSED on disappearance");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
