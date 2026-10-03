import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.DAVE_DATA_ROOT = mkdtempSync(join(tmpdir(), "rest-"));

/** Self-pause is rest (no scans) that any alert ends; an alert cuts a routine scan short. */
const sp = await import("../src/self-pause.js");
const loop = await import("../src/trading-loop.js");
const { focusScanOnAlert, resetAlertFocus } = await import("../src/alert-focus.js");
const { setAutonomousTradingEnabled } = await import("../src/autonomous-trading-state.js");

const u = "owner";
assert.equal(sp.setSelfPause(u, 45, "nothing near a level").pausedUntil > Date.now() + 44 * 60_000, true, "rest can be long (up to 60 min)");
assert.equal(sp.setSelfPause(u, 500, "x").pausedUntil <= Date.now() + 60 * 60_000, true, "capped at an hour");

// Mode 2 running with a routine scan in flight.
setAutonomousTradingEnabled(u, true);
let ran = 0;
loop.startAutonomousTradingLoop(u, async () => void ran++, 0);
const routine = new AbortController();
loop.registerTick(u, routine, false);

resetAlertFocus();
assert.ok(focusScanOnAlert(u, "VOL_10", "SELF-AWARE ALERT: VOL_10 buy losing 10 min"));
assert.equal(sp.getSelfPause(u), null, "the alert woke Dave from rest");
assert.equal(routine.signal.aborted, true, "the routine scan was cut short for the alert");

const alertTick = new AbortController();
loop.registerTick(u, alertTick, true);
focusScanOnAlert(u, "XAUUSD", "level hit");
assert.equal(alertTick.signal.aborted, false, "an alert scan is never cut short by another alert");
loop.clearTick(u, alertTick);
loop.stopAutonomousTradingLoop(u);

assert.equal(sp.wakeFromSelfPause(u), null, "nothing to wake when not resting");
console.log("=== ALL ASSERTIONS PASSED ===");
process.exit(0);
