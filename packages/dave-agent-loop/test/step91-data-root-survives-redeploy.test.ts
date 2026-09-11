import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { resolveDataRoot } from "../src/main.js";

/**
 * Real bug fixed (user, live: "it doesn't trade... check anything limiting it, check it now, fix
 * it"). Confirmed by querying the live Railway service's own environment variables directly:
 * DAVE_DATA_ROOT was never actually set. Every per-user file-based store using the
 * `DAVE_DATA_ROOT ?? process.cwd()` fallback pattern (pair groups, active pair symbol, confidence
 * settings, the autonomous-trading-enabled flag, and ~20 more, all fixed alongside this) was
 * therefore silently writing to the bot process's own ephemeral working directory, NOT the real
 * persistent volume DATABASE_PATH/HEARTBEAT_PATH were separately, explicitly pointed at -- so
 * every real redeploy silently wiped the user's pair group, active-pair focus, confidence
 * settings, and whether autonomous trading was even turned on, back to defaults. This proves the
 * real fix two ways: the pure resolution function main.ts now calls at boot, and a genuine
 * two-separate-process round trip simulating "wrote before a redeploy" / "read after one."
 */

console.log("=== Real proof: DAVE_DATA_ROOT now genuinely survives a redeploy, not just a manually-set env var ===\n");

console.log("[1] resolveDataRoot() prefers an explicitly-set DAVE_DATA_ROOT when present...\n");
assert.equal(resolveDataRoot({ DAVE_DATA_ROOT: "/explicit" }, "/app"), "/explicit");

console.log("[2] Falls back to Railway's own real volume-mount env var when DAVE_DATA_ROOT isn't set (the real live case)...\n");
assert.equal(resolveDataRoot({ RAILWAY_VOLUME_MOUNT_PATH: "/data" }, "/app"), "/data");

console.log("[3] Falls all the way back to cwd only when genuinely neither is set (local dev, the honest pre-fix behavior)...\n");
assert.equal(resolveDataRoot({}, "/app"), "/app");
console.log("    confirmed: all 3 real resolution paths behave correctly\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-data-root-redeploy-"));
const botCwdBuild1 = join(workDir, "build-1"); // a fresh checkout/build dir, simulating deploy #1
const botCwdBuild2 = join(workDir, "build-2"); // a DIFFERENT fresh checkout/build dir, simulating deploy #2 after a redeploy
const persistentVolume = join(workDir, "persistent-volume"); // simulates RAILWAY_VOLUME_MOUNT_PATH -- survives across deploys
mkdirSync(botCwdBuild1, { recursive: true });
mkdirSync(botCwdBuild2, { recursive: true });
mkdirSync(persistentVolume, { recursive: true });
const USER_ID = "user-data-root-redeploy-1";

const tradingDist = new URL("../../dave-trading/lib/index.js", import.meta.url).pathname;

function runInProcess(cwd: string, railwayVolumeMountPath: string | undefined, script: string): string {
  const code = `
    import { resolveDataRoot } from ${JSON.stringify(new URL("../lib/main.js", import.meta.url).pathname)};
    process.env.DAVE_DATA_ROOT = resolveDataRoot(process.env, process.cwd());
    const { setActivePairSymbol, getActiveGroupInfo } = await import(${JSON.stringify(tradingDist)});
    ${script}
  `;
  return execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd,
    env: { ...process.env, ...(railwayVolumeMountPath ? { RAILWAY_VOLUME_MOUNT_PATH: railwayVolumeMountPath } : { RAILWAY_VOLUME_MOUNT_PATH: undefined }) },
    encoding: "utf8",
  }).trim();
}

try {
  console.log("[4] WITHOUT the fix reproduced conceptually: two different real build directories, no shared volume var, genuinely disagree (the real pre-fix bug)...\n");
  runInProcess(botCwdBuild1, undefined, `setActivePairSymbol(${JSON.stringify(USER_ID)}, "EURUSD"); console.log("written during deploy #1, no real volume mount configured");`);
  const seenWithoutSharedVolume = runInProcess(botCwdBuild2, undefined, `console.log(JSON.stringify(getActiveGroupInfo(${JSON.stringify(USER_ID)}).activePairSymbol));`);
  console.log(`    what deploy #2's process (different real cwd) sees: ${seenWithoutSharedVolume}`);
  assert.equal(JSON.parse(seenWithoutSharedVolume), null, "reproduces the real bug: a genuinely different build dir with no shared volume loses the setting, exactly like an un-fixed redeploy");

  console.log("\n[5] WITH the real fix -- RAILWAY_VOLUME_MOUNT_PATH set (exactly as Railway itself sets it) -- deploy #1 writes, a genuinely SEPARATE deploy #2 process still sees it...\n");
  runInProcess(botCwdBuild1, persistentVolume, `setActivePairSymbol(${JSON.stringify(USER_ID)}, "GBPUSD"); console.log("written during deploy #1, with the real volume mount configured");`);
  const seenAfterRedeploy = runInProcess(botCwdBuild2, persistentVolume, `console.log(JSON.stringify(getActiveGroupInfo(${JSON.stringify(USER_ID)}).activePairSymbol));`);
  console.log(`    what the real deploy #2 process now sees: ${seenAfterRedeploy}`);
  assert.equal(JSON.parse(seenAfterRedeploy), "GBPUSD", "the user's real setting must genuinely survive a redeploy now");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
