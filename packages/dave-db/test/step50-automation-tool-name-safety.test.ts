import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase, AUTOMATION_TOOLS, listAutomations, type AutomationToolContext } from "../src/index.js";
import { wireScheduledAutomations, type AutomationDispatch } from "../src/automation-runtime.js";

/**
 * Real bug found via live Railway logs (user: "all the providers don't work again"): a stale
 * automation with `toolName: "tg_send_message"` -- never a real registered tool -- fired every
 * single cron tick FOREVER, throwing the same UnknownToolError over and over with nothing ever
 * stopping it. Two real fixes proven here: (1) create_automation now genuinely refuses a toolName
 * that isn't a real registered tool, so a new one can never be created broken; (2) an existing
 * automation whose tool genuinely doesn't resolve auto-pauses itself the first time it's hit,
 * instead of erroring on every future tick forever.
 */

console.log("=== Real proof: automations can't be created against, or keep firing against, a nonexistent tool ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-automation-tool-safety-"));
const OWNER = "user-automation-tool-safety-1";

try {
  const db = new DaveDatabase(join(workDir, "dave.db"));
  const knownTools = new Set(["real_tool"]);
  const ctx: AutomationToolContext = {
    userId: OWNER,
    db,
    isKnownTool: (name) => knownTools.has(name),
  };
  const byName = Object.fromEntries(AUTOMATION_TOOLS.map((t) => [t.name, t]));

  console.log("[1] create_automation genuinely refuses a toolName that isn't a real registered tool...\n");
  let refused = false;
  try {
    await byName.create_automation.execute({ name: "broken", triggerType: "scheduled", cronExpression: "* * * * *", toolName: "tg_send_message" }, ctx);
  } catch (err) {
    refused = err instanceof Error && err.name === "UnknownAutomationToolError";
  }
  assert.ok(refused, "must genuinely refuse to persist an automation against a tool that doesn't exist");
  assert.equal(listAutomations(db, OWNER).length, 0, "the broken automation must never have been written");
  console.log("    genuinely refused: UnknownAutomationToolError -- no row was ever written");

  console.log("\n[2] create_automation still genuinely succeeds for a real, known tool name...\n");
  const created = (await byName.create_automation.execute({ name: "real one", triggerType: "scheduled", cronExpression: "* * * * * *", toolName: "real_tool" }, ctx)) as { id: string };
  assert.ok(created.id);
  console.log(`    real automation created: ${created.id}`);

  console.log("\n[3] An automation whose tool genuinely stops resolving (simulating a rename/removal) auto-pauses itself instead of erroring forever...\n");
  const dispatch: AutomationDispatch = async () => {
    const err = new Error('No tool named "real_tool" is registered.');
    err.name = "UnknownToolError";
    throw err;
  };
  wireScheduledAutomations(db, OWNER, dispatch);
  await new Promise((r) => setTimeout(r, 1300));

  const stillListed = listAutomations(db, OWNER).find((a) => a.id === created.id);
  assert.ok(stillListed, "the automation record itself must survive (auto-PAUSED, not deleted)");
  assert.equal(stillListed!.enabled, false, "it must have genuinely been auto-disabled after hitting the real UnknownToolError");
  console.log(`    real automation auto-paused: enabled=${stillListed!.enabled}`);

  console.log("\n[4] Once paused, it genuinely stops re-throwing on every future tick (no infinite error loop)...\n");
  let threwAgain = false;
  const dispatch2: AutomationDispatch = async () => {
    threwAgain = true;
  };
  wireScheduledAutomations(db, OWNER, dispatch2);
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(threwAgain, false, "a paused automation must not fire at all anymore");
  console.log("    genuinely stayed silent -- the auto-pause held, no more ticks fired");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
