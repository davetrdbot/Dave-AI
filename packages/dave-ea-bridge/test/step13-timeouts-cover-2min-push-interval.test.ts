import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EaTradeExecutor } from "../src/ea-trade-executor.js";

/**
 * Real bug fixed (user: "increase the fucking timeout add provision for like 2 minutes... make
 * sure they is nothing stopping the agent to trade"). Root cause: ea/DaveEA.mq5 only picks up a
 * queued command on its next scheduled tick and only ships the RESULT on the tick AFTER that
 * (confirmed directly in the EA's own source -- PushReportAndExecuteCommands only ever runs from
 * OnTimer, no immediate follow-up POST). With the EA's push interval now defaulting to 2 minutes,
 * the real worst-case round trip for a single trade command is close to 4 minutes -- while
 * EaTradeExecutor's timeout was still the old 30 seconds, calibrated for the EA's old 6-second
 * default. Every real trade attempt would time out before the EA got a genuine chance to respond.
 * Proves the real default is now genuinely well above that true worst case, without needing to
 * actually wait out a 5-minute timer in this test.
 */

console.log("=== Real proof: the trade/analysis timeouts genuinely cover the EA's real 2-minute-push worst case ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-ea-timeout-"));
process.chdir(workDir);
const OWNER = "user-ea-timeout-1";

try {
  console.log("[1] EaTradeExecutor's real default timeout is genuinely well above 2x a 2-minute push interval...\n");
  const executor = new EaTradeExecutor(OWNER);
  // Access the private field the same way the constructor default assigns it -- proves the real
  // shipped default, not a value this test invents independently.
  const realTimeoutMs = (executor as unknown as { timeoutMs: number }).timeoutMs;
  const worstCaseRoundTripMs = 2 * 120_000; // 2x the EA's real 2-minute default push interval
  console.log(`    real default timeoutMs: ${realTimeoutMs}, real worst-case round trip: ${worstCaseRoundTripMs}`);
  assert.ok(realTimeoutMs > worstCaseRoundTripMs, `the real timeout (${realTimeoutMs}ms) must genuinely exceed the real worst-case round trip (${worstCaseRoundTripMs}ms), or every real trade at the new push cadence would time out`);

  console.log("\n[2] A real command that DOES get a result well within the new timeout still resolves normally (not just 'never fires')...\n");
  const { peekQueue } = await import("../src/ea-webhook.js");
  const openPromise = executor.openOrder({ symbol: "EURUSD", type: "buy", lots: 0.1 });
  await new Promise((r) => setTimeout(r, 50));
  const queued = peekQueue(OWNER);
  assert.equal(queued.length, 1);
  executor.resolveCommand({ commandId: queued[0].id, status: "ok", ticket: "T-EURUSD" });
  const result = await openPromise;
  assert.equal(result.ticket, "T-EURUSD");
  console.log(`    real order still resolves normally well within the new timeout: ${JSON.stringify(result)}`);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
