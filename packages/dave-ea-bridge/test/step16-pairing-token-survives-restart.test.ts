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
    import { getOrCreateEaWebhook } from ${JSON.stringify(eaBridgeDist)};
    ${script}
  `;
  return execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: processCwd,
    env: { ...process.env, DAVE_DATA_ROOT: dataRoot },
    encoding: "utf8",
  }).trim();
}

try {
  console.log("[1] A real first process (simulating the first real deploy) generates a real token...\n");
  const tokenFromFirstProcess = runInRealSeparateProcess(`console.log(getOrCreateEaWebhook(${JSON.stringify(USER_ID)}).token);`);
  console.log(`    real token from process #1: ${tokenFromFirstProcess}`);
  assert.match(tokenFromFirstProcess, /^DAVE-default-[0-9A-F]{8}$/);

  console.log("\n[2] A genuinely SEPARATE real Node process (simulating a real restart/redeploy), sharing the\n    same real DAVE_DATA_ROOT, reads back the EXACT SAME token -- never regenerated...\n");
  const tokenFromSecondProcess = runInRealSeparateProcess(`console.log(getOrCreateEaWebhook(${JSON.stringify(USER_ID)}).token);`);
  console.log(`    real token from process #2 (a genuinely new process): ${tokenFromSecondProcess}`);
  assert.equal(tokenFromSecondProcess, tokenFromFirstProcess, "the real token must survive a genuine process restart -- never silently regenerated");

  console.log("\n[3] A THIRD real separate process, same real data root, still agrees -- not a fluke...\n");
  const tokenFromThirdProcess = runInRealSeparateProcess(`console.log(getOrCreateEaWebhook(${JSON.stringify(USER_ID)}).token);`);
  assert.equal(tokenFromThirdProcess, tokenFromFirstProcess);
  console.log(`    real token from process #3: ${tokenFromThirdProcess} -- stable across real restarts`);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(dataRoot, { recursive: true, force: true });
}

process.exit(0);
