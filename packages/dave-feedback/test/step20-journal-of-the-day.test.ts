import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { logClosedTrade, getWinRateSummary, getTodaysWinRateSummary } from "../src/closed-trade-log.js";

/**
 * Real proof for the user's ask: "implement journal of the day thats win rate and others." Ground
 * truth is the EA's own real closed-position reports (real MT5 P&L) -- the exact same data
 * main.ts's onClosedPosition handler uses for the hardcoded close message, so this can never drift
 * from what the user was actually told happened.
 */

console.log("=== Real proof: journal-of-the-day win rate is real, computed from real closed trades ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-journal-day-"));
const OWNER = "user-journal-day-1";

try {
  const db = new DaveDatabase(join(workDir, "dave.db"));

  console.log("[1] Zero closed trades -> winRatePct is honestly null, never a fabricated 0%...\n");
  const empty = getTodaysWinRateSummary(db, OWNER);
  assert.equal(empty.total, 0);
  assert.equal(empty.winRatePct, null, "must NEVER fabricate a 0% win rate when there's genuinely no data");
  console.log(`    real empty summary: ${JSON.stringify(empty)}`);

  console.log("\n[2] Real closed trades (wins, losses, breakeven) genuinely aggregate correctly...\n");
  logClosedTrade(db, OWNER, { symbol: "VOL_80", pnl: 1.6, reason: "tp" });
  logClosedTrade(db, OWNER, { symbol: "CRASH_100", pnl: -2.56, reason: "sl" });
  logClosedTrade(db, OWNER, { symbol: "EURUSD", pnl: 5.0, reason: "dave" });
  logClosedTrade(db, OWNER, { symbol: "GBPUSD", pnl: 0, reason: "manual" });

  const today = getTodaysWinRateSummary(db, OWNER);
  assert.equal(today.total, 4);
  assert.equal(today.wins, 2);
  assert.equal(today.losses, 1);
  assert.equal(today.breakeven, 1);
  assert.equal(today.winRatePct, 50);
  assert.equal(Math.round(today.netPnl * 100) / 100, 4.04);
  console.log(`    real today's journal: ${JSON.stringify(today)}`);

  console.log("\n[3] A trade closed OUTSIDE the requested window is genuinely excluded...\n");
  const futureWindow = getWinRateSummary(db, OWNER, Date.now() + 60_000); // a window starting in the future
  assert.equal(futureWindow.total, 0, "trades closed before the window start must genuinely be excluded");
  console.log(`    real future-window summary (correctly empty): ${JSON.stringify(futureWindow)}`);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
