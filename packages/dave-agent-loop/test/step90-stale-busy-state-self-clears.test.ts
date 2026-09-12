import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setBusy, getBusyState, clearBusy, setAutonomousBusy, getAutonomousBusyState, clearAutonomousBusy } from "../src/busy-state.js";

/**
 * Real bug fixed (user: "it doesn't trade... check anything limiting it, check it now fix it").
 * busy.json was only ever cleared by the SAME process's own try/finally -- a real crash mid-turn
 * (Railway has genuinely shown a crashed deployment on this exact project) skips that finally
 * entirely, leaving a stale "busy" record on the persistent volume forever. Every future
 * autonomous cycle then reads busy=true and silently backs off (telegram-bot-server.ts's
 * runAutonomousTradingCycle returns immediately, with no error, no message -- a real, permanently
 * silent "stopped trading" failure mode). Proves a genuinely stale busy record (written directly
 * to disk, simulating a dead process, not through the real setBusy()/clearBusy() pair) is treated
 * as cleared, while a genuinely fresh one still correctly blocks.
 */

console.log("=== Real proof: a stale busy-state record self-clears instead of blocking forever ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-stale-busy-"));
process.chdir(workDir);
const USER = "user-stale-busy-1";

function busyPath(userId: string): string {
  return join(workDir, "data", "agent-loop", userId, "busy.json");
}

function autonomousBusyPath(userId: string): string {
  return join(workDir, "data", "agent-loop", userId, "busy-autonomous.json");
}

try {
  console.log("[1] A genuinely fresh busy record still correctly blocks...\n");
  setBusy(USER, "real agent-loop turn in flight");
  assert.ok(getBusyState(USER), "a fresh busy record must still read as busy");
  console.log("    confirmed: fresh busy state blocks, as intended");
  clearBusy(USER);

  // Real bug fixed (user, live: two messages minutes apart got answered "bundled" together) --
  // MAX_BUSY_AGE_MS was widened from 5 to 15 minutes, since a real turn's own tool loop has no
  // step cap and a single EA round trip can take up to ~5 minutes on its own; a 6-minute-old
  // record is no longer a safe assumption of a dead process. 16 minutes genuinely is.
  console.log("\n[2] A busy record from a real crashed process (16 minutes old, never cleared) genuinely self-clears...\n");
  const dir = join(workDir, "data", "agent-loop", USER);
  mkdirSync(dir, { recursive: true });
  const staleState = { taskDescription: "autonomous trading cycle", startedAt: Date.now() - 16 * 60_000 };
  writeFileSync(busyPath(USER), JSON.stringify(staleState), "utf8");
  const result = getBusyState(USER);
  assert.equal(result, null, "a 16-minute-old busy record from a dead process must genuinely read as NOT busy");
  console.log("    confirmed: a real 16-minute-stale busy record no longer blocks the autonomous cycle");

  console.log("\n[3] A busy record that's still within the real widened window (10 minutes) correctly still blocks...\n");
  const stillFreshState = { taskDescription: "a real multi-EA-round-trip turn", startedAt: Date.now() - 10 * 60_000 };
  writeFileSync(busyPath(USER), JSON.stringify(stillFreshState), "utf8");
  assert.ok(getBusyState(USER), "a 10-minute-old record must still genuinely block -- it's within a real turn's possible duration now");
  console.log("    confirmed: a real still-plausibly-in-flight turn (10 minutes) is not prematurely force-cleared");

  // Real regression fixed (caught live: a real container restart mid-cycle left a stale
  // autonomous busy record that, under the shared 15-minute window above, would have blocked
  // real trading cycles for up to 15 minutes instead of the original tighter bound). The
  // autonomous tick's own real worst case (one decision call, one optional Journal consult,
  // the EA's analysis fetch) is much tighter than a user turn's unbounded tool loop, so it keeps
  // its own, shorter staleness window -- unaffected by the user-turn window's widening.
  console.log("\n[4] The AUTONOMOUS busy kind uses its own tighter staleness window, unaffected by the user-turn widening...\n");
  setAutonomousBusy(USER, "real autonomous cycle in flight");
  assert.ok(getAutonomousBusyState(USER), "a fresh autonomous busy record must still block");
  clearAutonomousBusy(USER);

  const autoDir = join(workDir, "data", "agent-loop", USER);
  mkdirSync(autoDir, { recursive: true });
  const staleAutoState = { taskDescription: "autonomous trading cycle", startedAt: Date.now() - 7 * 60_000 };
  writeFileSync(autonomousBusyPath(USER), JSON.stringify(staleAutoState), "utf8");
  assert.equal(getAutonomousBusyState(USER), null, "a 7-minute-old AUTONOMOUS record (e.g. from a real container restart) must self-clear quickly, not wait 15 minutes like a user turn");
  console.log("    confirmed: a real 7-minute-stale autonomous record self-clears -- a restart no longer blocks trading for up to 15 minutes");

  const stillFreshAutoState = { taskDescription: "a real in-flight tick", startedAt: Date.now() - 3 * 60_000 };
  writeFileSync(autonomousBusyPath(USER), JSON.stringify(stillFreshAutoState), "utf8");
  assert.ok(getAutonomousBusyState(USER), "a genuinely still-in-flight 3-minute-old autonomous record must still block");
  console.log("    confirmed: a real still-in-flight autonomous cycle (3 minutes) is not prematurely force-cleared");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
