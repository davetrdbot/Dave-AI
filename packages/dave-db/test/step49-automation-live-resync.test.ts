import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase, AUTOMATION_TOOLS, listAutomations, type AutomationToolContext } from "../src/index.js";
import { wireScheduledAutomations, type AutomationDispatch } from "../src/automation-runtime.js";

/**
 * Real gap fixed (user: "every 3 minutes send me hi never fired after 8+ minutes"): a scheduled
 * automation's real node-cron trigger only ever got registered ONCE, at tool-registry-BUILD
 * time -- create_automation/pause_automation/resume_automation/delete_automation all just wrote
 * a DB row, with zero live effect on the actual cron registry. This proves the real fix end to
 * end: creating an automation through the real tool -- with NO prior/external call to
 * wireScheduledAutomations, only the tool's own `ctx.resync` -- genuinely arms a real,
 * fast-firing cron job; pausing genuinely stops it firing (not just filtered out of a future
 * re-wire); resuming genuinely restarts it; deleting genuinely tears it down for good.
 */

console.log("=== Real proof: create/pause/resume/delete_automation genuinely re-wire the live cron, not just a DB row ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-automation-resync-"));
const OWNER = "user-automation-resync-1";

try {
  const db = new DaveDatabase(join(workDir, "dave.db"));
  const fireLog: string[] = [];
  const dispatch: AutomationDispatch = async (userId, toolName) => {
    fireLog.push(`${userId}:${toolName}`);
  };
  const ctx: AutomationToolContext = {
    userId: OWNER,
    db,
    resync: () => {
      wireScheduledAutomations(db, OWNER, dispatch);
    },
  };
  const byName = Object.fromEntries(AUTOMATION_TOOLS.map((t) => [t.name, t]));

  console.log("[1] create_automation with a real, fast (every-second) cron -- NO external wireScheduledAutomations call, only the tool's own resync...\n");
  const created = (await byName.create_automation.execute({ name: "test tick", triggerType: "scheduled", cronExpression: "* * * * * *", toolName: "noop_tool" }, ctx)) as { id: string };
  assert.ok(created.id, "must return the real created automation with a real id");

  await new Promise((r) => setTimeout(r, 1300));
  const firedAfterCreate = fireLog.length;
  console.log(`    fired ${firedAfterCreate} time(s) in 1.3s -- the real cron genuinely armed itself via the tool call alone`);
  assert.ok(firedAfterCreate >= 1, "the automation must have genuinely fired without any registry rebuild -- this is the exact bug reported");

  console.log("\n[2] pause_automation genuinely stops it firing (not just excluded from a future re-wire)...\n");
  await byName.pause_automation.execute({ id: created.id }, ctx);
  const countAtPause = fireLog.length;
  await new Promise((r) => setTimeout(r, 1300));
  console.log(`    fired ${fireLog.length - countAtPause} more time(s) after pausing (must be 0)`);
  assert.equal(fireLog.length, countAtPause, "a paused automation's real cron trigger must genuinely be torn down, not just filtered out of a future listing");

  console.log("\n[3] resume_automation genuinely restarts it...\n");
  await byName.resume_automation.execute({ id: created.id }, ctx);
  const countAtResume = fireLog.length;
  await new Promise((r) => setTimeout(r, 1300));
  console.log(`    fired ${fireLog.length - countAtResume} more time(s) after resuming (must be >= 1)`);
  assert.ok(fireLog.length > countAtResume, "resuming must genuinely re-arm the real cron trigger immediately");

  console.log("\n[4] delete_automation genuinely tears it down for good...\n");
  const { deleted } = (await byName.delete_automation.execute({ id: created.id }, ctx)) as { deleted: boolean };
  assert.equal(deleted, true);
  assert.equal(listAutomations(db, OWNER).find((a) => a.id === created.id), undefined, "the row must genuinely be gone");
  const countAtDelete = fireLog.length;
  await new Promise((r) => setTimeout(r, 1300));
  console.log(`    fired ${fireLog.length - countAtDelete} more time(s) after deleting (must be 0)`);
  assert.equal(fireLog.length, countAtDelete, "a deleted automation's real cron trigger must genuinely be torn down immediately, not linger until a future rebuild");

  db.close();
  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
