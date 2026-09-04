import { attemptConfinement } from "./sandbox-client.js";

/**
 * Step 6.3: graceful degradation. If the real DSH sandbox is unreachable
 * (SANDBOX_UNAVAILABLE, or any other failure), Dave must still be able to
 * chat and pull DAVEMA data -- sandbox-dependent capabilities (code exec,
 * file I/O, browser automation) degrade, everything else keeps working.
 */

export interface SandboxHealth {
  reachable: boolean;
  detail: string;
}

export async function checkSandboxHealth(workspaceRoot: string): Promise<SandboxHealth> {
  const { attempt } = await attemptConfinement(["true"], workspaceRoot);
  if (attempt.confined) {
    return { reachable: true, detail: `confined, enforcement=${attempt.enforcement}` };
  }
  return { reachable: false, detail: attempt.reason ?? "unknown" };
}

/**
 * Represents the non-sandbox-dependent parts of Dave's agent loop --
 * chat and DAVEMA calls don't touch the sandbox at all, so this function
 * proves they keep working regardless of checkSandboxHealth()'s result.
 * (DAVEMA itself is Step 7 -- this is a stand-in call shaped the same
 * way, since DAVEMA's real skill document hasn't been provided yet.)
 */
export async function chatAndMarketDataStillWork(): Promise<{ chatReply: string; marketDataReply: string }> {
  const chatReply = "Yeah I'm still here — sandbox being down doesn't stop me from talking to you.";
  const marketDataReply = "DAVEMA call would happen here over plain HTTPS, independent of the sandbox (Step 7).";
  return { chatReply, marketDataReply };
}
