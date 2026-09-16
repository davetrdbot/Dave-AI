import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  BACKGROUND_CHECK_TOOLS,
  createBackgroundCheck,
  listBackgroundChecks,
  getBackgroundCheck,
  finalizeBackgroundCheck,
  recordBackgroundCheckTick,
  DEFAULT_CHECK_EVERY_MS,
  DEFAULT_MAX_DURATION_MS,
  MIN_CHECK_EVERY_MS,
} from "../src/index.js";

const DATA_DIR = join(process.cwd(), "data");
rmSync(DATA_DIR, { recursive: true, force: true });

console.log("=== Background checks real proof ===\n");
const USER_ID = "tg-561209";

const startTool = BACKGROUND_CHECK_TOOLS.find((t) => t.name === "start_background_check")!;
const listTool = BACKGROUND_CHECK_TOOLS.find((t) => t.name === "list_background_checks")!;
const getTool = BACKGROUND_CHECK_TOOLS.find((t) => t.name === "get_background_check")!;
const stopTool = BACKGROUND_CHECK_TOOLS.find((t) => t.name === "stop_background_check")!;
const CTX = { ownerUserId: USER_ID };

// --- starting a check stores the reason (and whatToCheck) correctly ---
console.log("[1] start_background_check stores reason/whatToCheck verbatim and returns a real id...");
const REASON = "watching for XAUUSD to sweep the 2380 low before considering a reversal entry -- do NOT act until this fires.";
const WHAT = "has XAUUSD traded at or below 2380.00 yet, and if so did it reverse or continue lower";
const check1 = (await startTool.execute({ reason: REASON, whatToCheck: WHAT }, CTX)) as Awaited<ReturnType<typeof createBackgroundCheck>>;
console.log(`    created check ${check1.id}, status=${check1.status}`);
assert.ok(check1.id && check1.id.length > 0, "must return a real check id");
assert.equal(check1.reason, REASON, "reason must be stored byte-for-byte, not paraphrased");
assert.equal(check1.whatToCheck, WHAT);
assert.equal(check1.status, "active");
assert.equal(check1.checkEveryMs, DEFAULT_CHECK_EVERY_MS, "unspecified checkEveryMs must fall back to the real default");
assert.equal(check1.maxDurationMs, DEFAULT_MAX_DURATION_MS, "unspecified maxDurationMs must fall back to the real default (never unbounded)");
assert.equal(check1.expiresAt, check1.createdAt + DEFAULT_MAX_DURATION_MS);

console.log("\n[1b] A too-tight checkEveryMs is floored, never allowed to busy-loop...");
const check2 = (await startTool.execute({ reason: "quick watch", whatToCheck: "anything", checkEveryMs: 500, maxDurationMs: 60_000 }, CTX)) as Awaited<ReturnType<typeof createBackgroundCheck>>;
assert.equal(check2.checkEveryMs, MIN_CHECK_EVERY_MS, "checkEveryMs must be floored to MIN_CHECK_EVERY_MS, not honored as-is");

console.log("\n[1c] reason/whatToCheck are required -- never silently started blank...");
let missingReasonRejected = false;
try {
  await startTool.execute({ whatToCheck: "something" }, CTX);
} catch {
  missingReasonRejected = true;
}
assert.ok(missingReasonRejected, "starting a check with no reason must be refused");

// --- listing shows pending checks ---
console.log("\n[2] list_background_checks shows only active checks by default...");
const activeList = (await listTool.execute({}, CTX)) as Array<{ id: string; status: string }>;
console.log(`    active: ${activeList.map((c) => c.id).join(", ")}`);
assert.equal(activeList.length, 2);
assert.ok(activeList.some((c) => c.id === check1.id));
assert.ok(activeList.some((c) => c.id === check2.id));

// --- stopping cancels cleanly ---
console.log("\n[3] stop_background_check cancels cleanly -- flips to 'stopped', drops out of the active list...");
const stopResult = await stopTool.execute({ checkId: check2.id }, CTX);
assert.deepEqual(stopResult, { ok: true });
const afterStop = (await listTool.execute({}, CTX)) as Array<{ id: string }>;
assert.equal(afterStop.length, 1, "stopped check must no longer appear in the active list");
assert.ok(!afterStop.some((c) => c.id === check2.id));
const stoppedRecord = (await getTool.execute({ checkId: check2.id }, CTX)) as Awaited<ReturnType<typeof createBackgroundCheck>>;
assert.equal(stoppedRecord.status, "stopped");
assert.ok(stoppedRecord.outcome, "a stopped check must record a real outcome note");

console.log("\n[3b] Stopping an already-finished check is a harmless no-op, not a crash...");
await stopTool.execute({ checkId: check2.id }, CTX); // already stopped -- must not throw
const stillStopped = (await getTool.execute({ checkId: check2.id }, CTX)) as Awaited<ReturnType<typeof createBackgroundCheck>>;
assert.equal(stillStopped.status, "stopped");

console.log("\n[3c] get_background_check on an unknown id is a real error, not undefined...");
let unknownRejected = false;
try {
  await getTool.execute({ checkId: "does-not-exist" }, CTX);
} catch {
  unknownRejected = true;
}
assert.ok(unknownRejected);

// --- a check firing resurfaces the original reason verbatim ---
console.log("\n[4] A fired check resurfaces the ORIGINAL reason byte-for-byte -- never re-derived...");
const weirdReason = "  because #XAUUSD swept liquidity at 2380 -- \"key level\", per the 4H chart (see screenshot). Do NOT touch until confirmed!!  ";
const check3 = createBackgroundCheck(USER_ID, { reason: weirdReason, whatToCheck: "did price sweep 2380 and reverse" });
recordBackgroundCheckTick(USER_ID, check3.id);
recordBackgroundCheckTick(USER_ID, check3.id);
const finished = finalizeBackgroundCheck(USER_ID, check3.id, "met", "XAUUSD swept 2380.10 at 14:02 UTC and reversed to 2384 within 20 minutes.");
console.log(`    reason resurfaced: "${finished.reason}"`);
assert.equal(finished.reason, weirdReason, "reason must come back EXACTLY as originally written -- whitespace, punctuation, everything");
assert.equal(finished.status, "met");
assert.equal(finished.checkCount, 2, "each real tick must be counted");
assert.ok(finished.outcome?.includes("2380.10"), "the real outcome must be attached alongside the reason");

console.log("\n[4b] finalize is idempotent -- a race between a tick concluding and a manual stop never clobbers the first real outcome...");
const reFinalized = finalizeBackgroundCheck(USER_ID, check3.id, "stopped", "should never overwrite -- already terminal");
assert.equal(reFinalized.status, "met", "a check that's already terminal must not be silently reassigned a different status");
assert.ok(reFinalized.outcome?.includes("2380.10"));

// --- a check exceeding maxDurationMs auto-expires (bookkeeping side: real deadline math) ---
console.log("\n[5] maxDurationMs is a real, enforced ceiling -- never unbounded, and expiry is real wall-clock math...");
const shortLived = createBackgroundCheck(USER_ID, { reason: "brief watch", whatToCheck: "anything", maxDurationMs: 1000 });
assert.equal(shortLived.expiresAt, shortLived.createdAt + 1000);
assert.ok(Date.now() < shortLived.expiresAt, "not expired yet at creation");
// The real deadline-crossing + notify behavior itself is driven by the polling engine
// (dave-agent-loop/background-check-loop.ts, which owns the real timer + Telegram notify --
// dave-workers must never depend on dave-agent-loop) -- proven end-to-end in
// packages/dave-agent-loop/test/background-check-loop.test.ts. This proves the real record-level
// contract that engine relies on: a genuine, bounded expiresAt that's never left unset.
const expiredFinish = finalizeBackgroundCheck(USER_ID, shortLived.id, "expired", "Timed out after 1000ms without the condition being met.");
assert.equal(expiredFinish.status, "expired");
assert.equal(expiredFinish.reason, "brief watch");
assert.match(expiredFinish.outcome ?? "", /Timed out/);

rmSync(DATA_DIR, { recursive: true, force: true });
console.log("\n=== ALL ASSERTIONS PASSED ===");
