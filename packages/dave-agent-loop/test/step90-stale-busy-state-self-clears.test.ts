import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setBusy, getBusyState, clearBusy } from "../src/busy-state.js";

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

try {
  console.log("[1] A genuinely fresh busy record still correctly blocks...\n");
  setBusy(USER, "real agent-loop turn in flight");
  assert.ok(getBusyState(USER), "a fresh busy record must still read as busy");
  console.log("    confirmed: fresh busy state blocks, as intended");
  clearBusy(USER);

  console.log("\n[2] A busy record from a real crashed process (6 minutes old, never cleared) genuinely self-clears...\n");
  const dir = join(workDir, "data", "agent-loop", USER);
  mkdirSync(dir, { recursive: true });
  const staleState = { taskDescription: "autonomous trading cycle", startedAt: Date.now() - 6 * 60_000 };
  writeFileSync(busyPath(USER), JSON.stringify(staleState), "utf8");
  const result = getBusyState(USER);
  assert.equal(result, null, "a 6-minute-old busy record from a dead process must genuinely read as NOT busy");
  console.log("    confirmed: a real 6-minute-stale busy record no longer blocks the autonomous cycle");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
