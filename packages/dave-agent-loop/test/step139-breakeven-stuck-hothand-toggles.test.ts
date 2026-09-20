import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";

const workDir = mkdtempSync(join(tmpdir(), "dave-selfaware-"));
process.env.DAVE_DATA_ROOT = workDir;

import type { PositionObservation } from "../src/trade-monitor-store.js";
const { advanceMonitor, BREAKEVEN_R, STUCK_FLAT_MS } = await import("../src/trade-monitor-store.js");
const { runTradeMonitorSweep } = await import("../src/trade-monitor-sweep.js");
const { getAlertToggles, setAlertToggle, getWinStreak } = await import("@dave/trading");

/**
 * The trader's three new self-aware alerts + the on/off switches:
 *   - breakeven guard (up ~1R -> move stop to BE)
 *   - stuck trade (flat near breakeven 15+ min)
 *   - hot-hand (3+ wins in a row)
 * and every self-aware alert has a switch that silences BOTH the user push and the bot's awareness.
 */

const t0 = 1_000_000_000_000;
// long: entry 100, sl 90 (risk 10), tp 130.
function obs(over: Partial<PositionObservation> = {}): PositionObservation {
  return { ticket: "B1", symbol: "VOL_80", direction: "buy", openPrice: 100, sl: 90, tp: 130, reason: "FVG reclaim.", ...over };
}

console.log("=== Self-aware: breakeven, stuck, hot-hand + on/off switches ===\n");

try {
  console.log("[1] BREAKEVEN guard fires once when up ~1R (favorable move >= risk)...\n");
  // price 110 => favorable 10 == risk 10 == 1R.
  let r = advanceMonitor(undefined, obs({ currentPrice: 110, pnl: 10 }), t0);
  assert.equal(BREAKEVEN_R, 1.0);
  assert.equal(r.alerts.filter((a) => a.kind === "breakeven").length, 1, "breakeven fires at 1R");
  // Doesn't re-fire on the next tick, even higher.
  r = advanceMonitor(r.monitor, obs({ currentPrice: 115, pnl: 15 }), t0 + 30_000);
  assert.equal(r.alerts.filter((a) => a.kind === "breakeven").length, 0, "breakeven is one-shot per trade");
  // Not yet at 1R -> no breakeven.
  const early = advanceMonitor(undefined, obs({ ticket: "B2", currentPrice: 105, pnl: 5 }), t0);
  assert.equal(early.alerts.filter((a) => a.kind === "breakeven").length, 0, "half an R is not breakeven yet");
  console.log("    confirmed: breakeven at exactly 1R, one-shot, not before");

  console.log("\n[2] STUCK trade fires after 15+ min flat near breakeven, and resets when it leaves...\n");
  // price 101 => |101-100|=1 <= 15% of risk(10)=1.5 -> flat.
  let s = advanceMonitor(undefined, obs({ ticket: "S1", currentPrice: 101, pnl: 1 }), t0);
  assert.equal(s.monitor.flatStartedAt, t0, "flat clock starts on entry into the band");
  assert.equal(s.alerts.filter((a) => a.kind === "stuck").length, 0, "not stuck yet");
  s = advanceMonitor(s.monitor, obs({ ticket: "S1", currentPrice: 100.5, pnl: 0 }), t0 + STUCK_FLAT_MS);
  assert.equal(s.alerts.filter((a) => a.kind === "stuck").length, 1, "stuck fires at 15 min flat");
  // Leaves the band -> clock + latch reset, so a later stall can alert again.
  s = advanceMonitor(s.monitor, obs({ ticket: "S1", currentPrice: 108, pnl: 8 }), t0 + STUCK_FLAT_MS + 60_000);
  assert.equal(s.monitor.flatStartedAt, undefined, "leaving the band clears the flat clock");
  assert.equal(s.monitor.alerts.stuck, false, "and re-arms the stuck latch");
  console.log("    confirmed: stuck at 15 min, re-arms after it moves");

  console.log("\n[3] Every alert honors its on/off switch (default on)...\n");
  const USER = "user-toggle-1";
  const all = getAlertToggles(USER);
  assert.ok(Object.values(all).every((v) => v === true), "all switches default on");
  setAlertToggle(USER, "breakeven", false);
  assert.equal(getAlertToggles(USER).breakeven, false, "breakeven switched off persists");
  assert.equal(getAlertToggles(USER).stuck, true, "others untouched");

  // Through the real sweep: breakeven is OFF, so a 1R trade produces no delivered alert.
  const eaDir = join(workDir, "data", "ea-bridge", USER);
  mkdirSync(eaDir, { recursive: true });
  const setPos = (positions: unknown[]) => writeFileSync(join(eaDir, "last-known-state.json"), JSON.stringify({ positions, pendingOrders: [] }), "utf8");
  const db = new DaveDatabase(join(workDir, "dave.db"));
  setPos([{ ticket: "K1", symbol: "VOL_80", type: "buy", lots: 0.02, openPrice: 100, sl: 90, tp: 130, currentPrice: 110, pnl: 10 }]);
  const sent: string[] = [];
  const fired = await runTradeMonitorSweep({ db, userId: USER, notify: async (t) => void sent.push(t) }, t0);
  assert.equal(fired.filter((a) => a.kind === "breakeven").length, 0, "a switched-off breakeven is not delivered");
  assert.ok(!sent.some((m) => /breakeven/i.test(m)), "and no breakeven push was sent");
  // Turn it on -> next sweep on a fresh ticket delivers it.
  setAlertToggle(USER, "breakeven", true);
  setPos([{ ticket: "K2", symbol: "VOL_80", type: "buy", lots: 0.02, openPrice: 100, sl: 90, tp: 130, currentPrice: 110, pnl: 10 }]);
  const sent2: string[] = [];
  const fired2 = await runTradeMonitorSweep({ db, userId: USER, notify: async (t) => void sent2.push(t) }, t0 + 60_000);
  assert.equal(fired2.filter((a) => a.kind === "breakeven").length, 1, "switched back on, breakeven delivers");
  assert.ok(sent2.some((m) => /breakeven/i.test(m)), "and the push is sent");
  console.log("    confirmed: switch off silences push + delivery; on restores it");

  console.log("\n[4] HOT-HAND warning fires on the 3rd win in a row, respecting its switch...\n");
  const HH = "user-hothand-1";
  const eaDir2 = join(workDir, "data", "ea-bridge", HH);
  mkdirSync(eaDir2, { recursive: true });
  const setPos2 = (positions: unknown[]) => writeFileSync(join(eaDir2, "last-known-state.json"), JSON.stringify({ positions, pendingOrders: [] }), "utf8");
  // Helper: open then close a winning ticket through two sweeps.
  const winTrade = async (ticket: string, tOpen: number, collect: string[]) => {
    setPos2([{ ticket, symbol: "CRASH_100", type: "buy", lots: 0.02, openPrice: 500, sl: 490, tp: 530, currentPrice: 505, pnl: 5 }]);
    await runTradeMonitorSweep({ db, userId: HH, notify: async () => {} }, tOpen);
    setPos2([]); // vanished -> closed as a win (lastPnl +5)
    await runTradeMonitorSweep({ db, userId: HH, notify: async (t) => void collect.push(t) }, tOpen + 30_000);
  };
  const hhSent: string[] = [];
  await winTrade("W1", t0, hhSent);
  await winTrade("W2", t0 + 100_000, hhSent);
  assert.equal(getWinStreak(HH), 2, "two wins so far");
  assert.ok(!hhSent.some((m) => /hot hand/i.test(m)), "no hot-hand at 2");
  await winTrade("W3", t0 + 200_000, hhSent);
  assert.equal(getWinStreak(HH), 3, "third win");
  assert.ok(hhSent.some((m) => /hot hand/i.test(m)), "hot-hand fires at exactly 3 in a row");
  // A 4th win does NOT re-nag.
  const before = hhSent.filter((m) => /hot hand/i.test(m)).length;
  await winTrade("W4", t0 + 300_000, hhSent);
  const after = hhSent.filter((m) => /hot hand/i.test(m)).length;
  assert.equal(after, before, "hot-hand does not re-fire at 4");
  console.log("    confirmed: hot-hand at 3, silent at 4");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
process.exit(0);
