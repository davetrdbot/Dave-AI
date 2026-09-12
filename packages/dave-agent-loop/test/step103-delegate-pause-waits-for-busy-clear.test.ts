import assert from "node:assert/strict";
import { waitForBusyToClear, type BusyState } from "../src/busy-state.js";

/**
 * Real bug fixed (independent audit, confirmed): the "delegate:pause" callback handler in
 * telegram-bot-server.ts started a SECOND runAgentTurn() for the queued message as soon as the
 * button was tapped, assuming the ORIGINAL (still possibly in-flight) turn had already finished.
 * It hadn't necessarily -- runAgentTurn's own setBusy()/clearBusy() only clears once loop.run()
 * genuinely returns, and a slow tool call can still be running when the button is tapped. Both
 * runAgentTurn calls then load conversation-store.ts history around the same starting point and
 * each save their own final result -- whichever save lands last silently overwrites the other's
 * real exchange, with no error anywhere.
 *
 * Fix: waitForBusyToClear() (busy-state.ts) is now genuinely awaited before delegate:pause starts
 * the queued runAgentTurn, polling the real busy flag until it's actually clear instead of
 * assuming it already is. This proves the REAL timing behavior -- that it genuinely waits across
 * several poll ticks while busy is still true, and only resolves once busy actually clears -- not
 * merely that the function exists or returns eventually.
 */

console.log("=== Real proof: delegate:pause genuinely waits for the original turn's busy flag to clear ===\n");

async function testGenuinelyWaitsThenResolvesOnceCleared() {
  console.log("[1] Busy is true for a few simulated poll ticks, then clears -- waitForBusyToClear must not resolve early...\n");

  let simulatedNow = 0;
  const sleepCalls: number[] = [];
  // Real fake: busy stays true until a specific number of poll ticks have genuinely happened,
  // simulating the original in-flight turn still running through several poll intervals before
  // it actually finishes and clears busy.
  let pollsSoFar = 0;
  const CLEARS_AFTER_POLLS = 4;
  const fakeBusy: BusyState = { taskDescription: "real in-flight original turn", startedAt: 0 };
  const getBusy = (userId: string): BusyState | null => {
    if (userId !== "user-wait-1") return null;
    return pollsSoFar >= CLEARS_AFTER_POLLS ? null : fakeBusy;
  };

  const fakeSleep = async (ms: number) => {
    sleepCalls.push(ms);
    pollsSoFar++;
    simulatedNow += ms;
  };

  const result = await waitForBusyToClear("user-wait-1", {
    pollIntervalMs: 250,
    timeoutMs: 60_000,
    getBusy,
    sleep: fakeSleep,
    now: () => simulatedNow,
  });

  console.log(`    real poll count before clearing: ${sleepCalls.length}`);
  console.log(`    real result: ${JSON.stringify(result)}`);

  // The core proof: this must have genuinely polled (and thus genuinely waited) across multiple
  // ticks while busy was still reported true -- NOT resolved on the very first check while busy
  // was still true (that would mean it started the second runAgentTurn concurrently with the
  // first, exactly the race being fixed).
  assert.equal(sleepCalls.length, CLEARS_AFTER_POLLS, "must have genuinely polled once per tick until busy actually cleared, not resolved early");
  assert.ok(sleepCalls.every((ms) => ms === 250), "must use the real configured poll interval on every real wait, not a fixed/fake single wait");
  assert.equal(result.cleared, true, "must report that busy genuinely cleared, not that it timed out");
  assert.equal(result.waitedMs, CLEARS_AFTER_POLLS * 250, "the real waited time must reflect the real number of poll intervals actually elapsed");
  console.log("    confirmed: genuinely waited through every tick where busy was still true, resolved only once it actually cleared\n");
}

async function testNeverPollsWhenAlreadyClear() {
  console.log("[2] Busy is already clear on the very first check -- must resolve immediately, with zero waiting...\n");
  const sleepCalls: number[] = [];
  const result = await waitForBusyToClear("user-wait-2", {
    getBusy: () => null,
    sleep: async (ms) => { sleepCalls.push(ms); },
    now: () => 0,
  });
  assert.equal(sleepCalls.length, 0, "must not sleep at all when busy is already clear");
  assert.equal(result.cleared, true);
  assert.equal(result.waitedMs, 0);
  console.log("    confirmed: no artificial delay when the original turn already finished\n");
}

async function testBoundedTimeoutProceedsAnywayAndLogs() {
  console.log("[3] Busy genuinely never clears -- must give up after the real bounded timeout and proceed anyway (not hang forever)...\n");
  const fakeBusy: BusyState = { taskDescription: "stuck turn", startedAt: 0 };
  let simulatedNow = 0;
  const sleepCalls: number[] = [];
  const originalWarn = console.warn;
  let warned = false;
  console.warn = (...args: unknown[]) => {
    warned = true;
    originalWarn(...args);
  };
  try {
    const result = await waitForBusyToClear("user-wait-3", {
      pollIntervalMs: 1000,
      timeoutMs: 3000,
      getBusy: () => fakeBusy,
      sleep: async (ms) => { sleepCalls.push(ms); simulatedNow += ms; },
      now: () => simulatedNow,
    });
    console.log(`    real poll count before giving up: ${sleepCalls.length}`);
    console.log(`    real result: ${JSON.stringify(result)}`);
    assert.equal(result.cleared, false, "must honestly report it did NOT confirm busy actually cleared");
    assert.ok(result.waitedMs >= 3000, "must have genuinely waited at least the full configured timeout before giving up");
    assert.ok(warned, "must log clearly when proceeding without a confirmed clear, so this isn't a second silent failure mode");
    console.log("    confirmed: bounded wait, proceeds anyway past the ceiling, and logs it loudly rather than hanging the button handler forever\n");
  } finally {
    console.warn = originalWarn;
  }
}

(async () => {
  await testGenuinelyWaitsThenResolvesOnceCleared();
  await testNeverPollsWhenAlreadyClear();
  await testBoundedTimeoutProceedsAnywayAndLogs();
  console.log("=== ALL ASSERTIONS PASSED ===");
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
