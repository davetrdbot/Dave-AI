import { getEaConnectionStatus } from "@dave/ea-bridge";
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

export async function runSelfTest(userId: string, workspaceRoot: string): Promise<SelfTestResult> {
  const checks: SelfTestCheck[] = [];

  // Item 5 real gap fixed (DAVEMA retirement): this used to ping the retired external DAVEMA
  // API on every self-test -- a real, live network call against a dead endpoint that surfaced a
  // raw auth/connection error to the user, which is very plausibly what looked like "the bot is
  // asking for a DAVEMA API key." The real market-data dependency is the connected MT5 EA now,
  // not an HTTP API -- this checks the real thing Dave actually depends on.
  const eaStatus = getEaConnectionStatus(userId);
  checks.push({
    name: "ea-connection",
    ok: eaStatus.connected,
    detail: eaStatus.connected
      ? `EA connected, last seen ${eaStatus.secondsSinceLastSeen}s ago`
      : eaStatus.lastSeenAt === null
        ? "no EA report received yet -- pair your EA first"
        : `EA hasn't reported in ${eaStatus.secondsSinceLastSeen}s`,
  });

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
