import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Real proof for item 10 (user: "'DAVE-default-C41983E2' should be a fixed, stable identifier
 * that does not regenerate on every update/deploy/restart. Confirm this and fix if it's
 * currently being regenerated."). Static review of ea-webhook.ts confirmed the token is written
 * to a real file (suffixesPath, DAVE_DATA_ROOT-aware) and only ever generated once -- but the
 * existing step12 test only proves stability across repeat calls WITHIN one process, which
 * doesn't actually rule out a real redeploy (a genuinely separate process) losing/regenerating
 * it. This proves the real thing the user asked about: two genuinely separate real Node
 * processes, simulating a real restart/redeploy, sharing the same real persisted data root, agree
 * on the exact same token -- it is never regenerated just because the process restarted.
 */

console.log("=== Real proof: the EA pairing token genuinely survives a real process restart ===\n");

const dataRoot = mkdtempSync(join(tmpdir(), "dave-pairing-restart-"));
const processCwd = join(dataRoot, "some-process-cwd");
mkdirSync(processCwd, { recursive: true });
const USER_ID = "default";

const eaBridgeDist = new URL("../lib/index.js", import.meta.url).pathname;

function runInRealSeparateProcess(script: string): string {
  const code = `
    import { getOrCreateEaWebhook, revokeEaToken } from ${JSON.stringify(eaBridgeDist)};
    ${script}
  `;
  return execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: processCwd,
    env: { ...process.env, DAVE_DATA_ROOT: dataRoot },
    encoding: "utf8",
  }).trim();
}

try {
  console.log("[1] A real first process (simulating the first real deploy) generates the real HARDCODED default token...\n");
  const tokenFromFirstProcess = runInRealSeparateProcess(`console.log(getOrCreateEaWebhook(${JSON.stringify(USER_ID)}).token);`);
  console.log(`    real token from process #1: ${tokenFromFirstProcess}`);
  assert.equal(tokenFromFirstProcess, "DAVE-default-C41983E2", "the real production default owner must genuinely get the user's explicit hardcoded token, not a random one");

  console.log("\n[2] A genuinely SEPARATE real Node process (simulating a real restart/redeploy), sharing the\n    same real DAVE_DATA_ROOT, reads back the EXACT SAME token -- never regenerated...\n");
  const tokenFromSecondProcess = runInRealSeparateProcess(`console.log(getOrCreateEaWebhook(${JSON.stringify(USER_ID)}).token);`);
  console.log(`    real token from process #2 (a genuinely new process): ${tokenFromSecondProcess}`);
  assert.equal(tokenFromSecondProcess, tokenFromFirstProcess, "the real token must survive a genuine process restart -- never silently regenerated");

  console.log("\n[3] A THIRD real separate process, same real data root, still agrees -- not a fluke...\n");
  const tokenFromThirdProcess = runInRealSeparateProcess(`console.log(getOrCreateEaWebhook(${JSON.stringify(USER_ID)}).token);`);
  assert.equal(tokenFromThirdProcess, tokenFromFirstProcess);
  console.log(`    real token from process #3: ${tokenFromThirdProcess} -- stable across real restarts`);

  console.log("\n[4] An instance that already had a DIFFERENT random suffix persisted (simulating an existing\n    live deployment from before this fix shipped) genuinely converges to the fixed token too...\n");
  const priorDataRoot = mkdtempSync(join(tmpdir(), "dave-pairing-restart-legacy-"));
  const priorCwd = join(priorDataRoot, "cwd");
  mkdirSync(priorCwd, { recursive: true });
  const runLegacy = (script: string) =>
    execFileSync(process.execPath, ["--input-type=module", "-e", `import { getOrCreateEaWebhook, revokeEaToken } from ${JSON.stringify(eaBridgeDist)};\n${script}`], {
      cwd: priorCwd,
      env: { ...process.env, DAVE_DATA_ROOT: priorDataRoot },
      encoding: "utf8",
    }).trim();
  // Simulate a pre-fix instance: directly write a random suffix, bypassing the real fixed-token migration.
  const { writeFileSync, mkdirSync: mkdirSyncFs } = await import("node:fs");
  mkdirSyncFs(join(priorDataRoot, "data", "ea-bridge"), { recursive: true });
  writeFileSync(join(priorDataRoot, "data", "ea-bridge", "token-suffixes.json"), JSON.stringify({ default: "AAAAAAAA" }), "utf8");
  const legacyToken = runLegacy(`console.log(getOrCreateEaWebhook(${JSON.stringify(USER_ID)}).token);`);
  assert.equal(legacyToken, "DAVE-default-C41983E2", "an existing random suffix must genuinely be migrated to the real fixed token, once");
  console.log(`    real converged token: ${legacyToken}`);

  console.log("\n[5] After that one-time convergence, a genuine revoke for the default user still works normally...\n");
  const revokedToken = runLegacy(`console.log(revokeEaToken(${JSON.stringify(USER_ID)}).token);`);
  assert.notEqual(revokedToken, "DAVE-default-C41983E2", "a real, deliberate revoke must genuinely still change the token -- the migration must never fight a real revoke");
  assert.match(revokedToken, /^DAVE-default-[0-9A-F]{8}$/);
  console.log(`    real token after a genuine revoke: ${revokedToken} -- revoke still genuinely works`);
  rmSync(priorDataRoot, { recursive: true, force: true });

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(dataRoot, { recursive: true, force: true });
}

process.exit(0);
