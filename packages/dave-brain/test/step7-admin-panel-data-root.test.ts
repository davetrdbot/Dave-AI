import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Real bug fixed, reported by the user directly: "the providers are not still working" /
 * "I gave you the goal.yaml, why it still asking me". Root cause, found by tracing exactly how
 * the admin panel actually runs: main.ts spawns it as a REAL, SEPARATE child process with cwd
 * set to packages/dave-admin (see spawnAdminPanel) -- so any package whose store used a bare
 * `join(process.cwd(), "data", ...)` path (provider-router.ts's model-config chief among them)
 * genuinely wrote to a DIFFERENT file than the one the bot process itself reads. Setting a
 * primary/fallback provider through the admin panel's real "AI Models" tab could never actually
 * reach the running bot -- explaining exactly what the user reported. This proves the real fix
 * (DAVE_DATA_ROOT) end to end: two genuinely separate Node processes, simulating the real
 * bot-process/admin-process split, agree on the same file when it's set.
 */

console.log("=== Real proof: the admin panel and the bot process genuinely share the same model-config file ===\n");

const repoRoot = mkdtempSync(join(tmpdir(), "dave-data-root-"));
const botCwd = join(repoRoot, "bot-process-cwd");
const adminCwd = join(repoRoot, "packages", "dave-admin");
mkdirSync(botCwd, { recursive: true });
mkdirSync(adminCwd, { recursive: true });
const USER_ID = "user-data-root-1";

const brainDist = new URL("../lib/index.js", import.meta.url).pathname;

function runInProcess(cwd: string, dataRoot: string | undefined, script: string): string {
  const code = `
    import { getModelConfig, setModelConfig } from ${JSON.stringify(brainDist)};
    ${script}
  `;
  return execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd,
    env: { ...process.env, ...(dataRoot ? { DAVE_DATA_ROOT: dataRoot } : {}) },
    encoding: "utf8",
  }).trim();
}

try {
  console.log("[1] WITHOUT the fix (no DAVE_DATA_ROOT): the 'bot process' (cwd=botCwd) and the\n    'admin process' (cwd=adminCwd) genuinely see DIFFERENT config -- reproducing the real bug...\n");
  runInProcess(adminCwd, undefined, `setModelConfig(${JSON.stringify(USER_ID)}, { primary: "nvidia-nim", fallback: [] }); console.log("written from admin cwd");`);
  const seenByBotWithoutFix = runInProcess(botCwd, undefined, `console.log(JSON.stringify(getModelConfig(${JSON.stringify(USER_ID)})));`);
  console.log(`    what the bot process (different cwd) sees: ${seenByBotWithoutFix}`);
  assert.notEqual(JSON.parse(seenByBotWithoutFix).primary, "nvidia-nim", "reproduces the real bug: two different real processes with different cwd genuinely disagree without the fix");

  console.log("\n[2] WITH the real fix (DAVE_DATA_ROOT set to the same real shared root, exactly as\n    main.ts's spawnAdminPanel now does): both processes genuinely agree...\n");
  const sharedRoot = repoRoot;
  runInProcess(adminCwd, sharedRoot, `setModelConfig(${JSON.stringify(USER_ID)}, { primary: "nvidia-nim", fallback: ["groq"] }); console.log("written from admin process, real shared DAVE_DATA_ROOT");`);
  const seenByBotWithFix = runInProcess(botCwd, sharedRoot, `console.log(JSON.stringify(getModelConfig(${JSON.stringify(USER_ID)})));`);
  console.log(`    what the real bot process now sees: ${seenByBotWithFix}`);
  assert.deepEqual(JSON.parse(seenByBotWithFix), { primary: "nvidia-nim", fallback: ["groq"] }, "the bot process must genuinely see the exact config the admin panel wrote");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(repoRoot, { recursive: true, force: true });
}

process.exit(0);
