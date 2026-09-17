import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTradingLoopIntervalMinutes } from "../src/trading-loop-config.js";
import { startAutonomousTradingLoop, stopAutonomousTradingLoop, isAutonomousTradingRunning } from "../src/trading-loop.js";

/**
 * Real gap fixed (the trader, live, explicit: "add a feature for every 1 min to analyze... do
 * that yourself" -- a real admin-panel UI control for the scan interval, not just Telegram). The
 * admin panel is its own real child process -- it can never reach this module's in-memory state
 * to force a live re-arm, so a change it persists to the shared config file
 * (trading-loop-config.ts) only ever takes effect for a RUNNING loop if the scheduler itself
 * re-reads the config, not just once at start-up.
 *
 * Real bug found by LIVE verification of a first version of this fix (a self-rescheduling
 * setTimeout): re-reading the config before scheduling each NEXT wait sounds right, but a change
 * made mid-wait never touches the setTimeout handle that's ALREADY armed with the stale interval
 * -- a live run proved a config change made 3s into a 60-minute wait genuinely did not fire until
 * the full 60 minutes had passed, not "the very next tick" the original comment claimed. This
 * test's [3] is the part that actually catches that class of bug -- earlier versions of this test
 * only asserted the config FILE reflected the new value (never in doubt -- the file write itself
 * is just JSON.stringify) without ever proving a real tick actually fired on the new cadence. Real
 * timers, not simulated -- this is deliberately slow (~65s) because a fake-timer version can't
 * catch a bug that's specifically about what a REAL pending timer does.
 */

console.log("=== Real proof: a scan-interval change written from OUTSIDE this process's own re-arm path makes a REAL tick fire on the new cadence, not the stale one ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-cross-process-interval-"));
process.chdir(workDir);
const OWNER = "user-cross-process-interval-1";

let tickCount = 0;
const tickTimestamps: number[] = [];
const runCycle = async () => {
  tickCount++;
  tickTimestamps.push(Date.now());
};

try {
  console.log("[1] Start the loop at a real, deliberately slow cadence (60 min) -- nothing should fire on its own within this test's real window at that cadence...\n");
  const start = Date.now();
  setTradingLoopIntervalMinutes(OWNER, 60);
  const started = startAutonomousTradingLoop(OWNER, runCycle);
  assert.ok(started);
  assert.equal(isAutonomousTradingRunning(OWNER), true);

  console.log("[2] Simulate the admin panel: persist a MUCH faster interval (the real minimum, 1 min) by writing straight to the shared config file a few seconds in -- bypassing this process's own explicit re-arm call (setAutonomousTradingIntervalMinutes) entirely, exactly like a genuinely separate process would...\n");
  await new Promise((r) => setTimeout(r, 3_000));
  setTradingLoopIntervalMinutes(OWNER, 1);

  console.log("\n[3] Wait for a REAL tick to actually fire, and confirm it does so on roughly the NEW 1-minute cadence (measured from this loop's own real last-cycle baseline) -- not stuck waiting out the stale 60-minute cadence it started with...\n");
  const deadline = Date.now() + 75_000;
  while (tickCount === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(tickCount, 1, `a real cycle must genuinely have fired by now -- if this is 0, the cross-process interval change never took effect (still stuck on the stale 60-minute cadence)`);
  const firedAfterMs = tickTimestamps[0] - start;
  console.log(`    real tick fired ${firedAfterMs}ms after start`);
  assert.ok(firedAfterMs < 70_000, `must fire well under the stale 60-minute cadence -- bounded by the NEW 1-minute interval instead (fired after ${firedAfterMs}ms)`);
  assert.ok(firedAfterMs > 20_000, `must not fire suspiciously early either -- a real ~60s wait (from this loop's own start, the real interval baseline) is expected, not an immediate fire (fired after ${firedAfterMs}ms)`);

  console.log("\n[4] The loop is still genuinely armed the whole time -- a config change alone never tears it down or requires a restart...\n");
  assert.equal(isAutonomousTradingRunning(OWNER), true);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  stopAutonomousTradingLoop(OWNER);
  rmSync(workDir, { recursive: true, force: true });
}
process.exit(0);
