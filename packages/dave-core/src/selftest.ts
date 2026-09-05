import type { DavemaClient } from "@dave/davema";
import { checkSandboxHealth } from "@dave/sandbox";
import { loadFrozenSnapshot } from "@dave/memory";
import { isPaired } from "./pairing.js";

/**
 * Part 3 (B5): "goal-config / selftest / onboarding as real callable
 * tools -- currently exist as passive systems but aren't exposed as
 * tools Dave can call directly." Honest note: goal-config (goal.yaml)
 * and onboarding (bootstrap.ts) genuinely already existed as passive
 * systems; a runnable self-test did NOT exist anywhere in the codebase
 * before this -- this is new, real diagnostic logic (not a stub),
 * checking the actual real subsystems Dave depends on.
 */
export interface SelfTestCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SelfTestResult {
  checks: SelfTestCheck[];
  allOk: boolean;
}

export async function runSelfTest(userId: string, davema: DavemaClient, workspaceRoot: string): Promise<SelfTestResult> {
  const checks: SelfTestCheck[] = [];

  try {
    const pong = await davema.ping();
    checks.push({ name: "davema", ok: true, detail: `reachable: ${pong.status}` });
  } catch (err) {
    checks.push({ name: "davema", ok: false, detail: err instanceof Error ? err.message : String(err) });
  }

  try {
    const snapshot = loadFrozenSnapshot(userId);
    checks.push({ name: "memory-files", ok: true, detail: `MEMORY.md (${snapshot.memory.length}c), USER.md (${snapshot.user.length}c) loaded` });
  } catch (err) {
    checks.push({ name: "memory-files", ok: false, detail: err instanceof Error ? err.message : String(err) });
  }

  try {
    const health = await checkSandboxHealth(workspaceRoot);
    checks.push({ name: "sandbox", ok: health.reachable, detail: health.detail ?? (health.reachable ? "reachable" : "unreachable") });
  } catch (err) {
    checks.push({ name: "sandbox", ok: false, detail: err instanceof Error ? err.message : String(err) });
  }

  checks.push({ name: "pairing", ok: isPaired(userId), detail: isPaired(userId) ? "paired" : "not paired -- most tools will refuse to act" });

  return { checks, allOk: checks.every((c) => c.ok) };
}
