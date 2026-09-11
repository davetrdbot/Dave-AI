import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCursorPosition, advanceCursor, PRIMARY_LAPS_BEFORE_FALLBACK } from "../src/autonomous-tick-state.js";

/**
 * Real dedicated proof for the round-robin cursor itself (plan's Verification section), isolated
 * from the full tick to make the lap-counting/fallback-switching logic easy to check directly:
 * advances every call regardless of what the caller does with the symbol, wraps correctly within
 * a lap, switches to the fallback group after PRIMARY_LAPS_BEFORE_FALLBACK completed primary laps,
 * returns to primary after exactly one fallback lap, and with no fallback group configured (length
 * 0) stays in primary indefinitely instead of ever trying to switch.
 */

console.log("=== Real proof: the round-robin symbol cursor's lap/fallback behavior ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-round-robin-cursor-"));
process.chdir(workDir);

console.log("[1] Cursor advances through a 3-symbol primary group, wrapping back to 0 after a full lap...\n");
{
  const USER = "user-cursor-1";
  const primaryLen = 3;
  const fallbackLen = 0;
  const seen: number[] = [];
  for (let i = 0; i < 4; i++) {
    seen.push(getCursorPosition(USER).symbolCursor);
    advanceCursor(USER, primaryLen, fallbackLen);
  }
  assert.deepEqual(seen, [0, 1, 2, 0], "must visit every index once per lap, wrapping back to 0 on the 4th call");
  console.log(`    real cursor sequence: ${seen.join(" -> ")}`);
}

console.log("\n[2] No fallback group configured (length 0) -- cursor stays in primary indefinitely, never switches...\n");
{
  const USER = "user-cursor-2";
  const primaryLen = 2;
  const fallbackLen = 0;
  for (let i = 0; i < (primaryLen * PRIMARY_LAPS_BEFORE_FALLBACK) + 5; i++) {
    advanceCursor(USER, primaryLen, fallbackLen);
  }
  const state = getCursorPosition(USER);
  assert.equal(state.scanningFallback, false, "must never switch to fallback when none is configured, no matter how many laps complete");
  console.log(`    real state after many laps with no fallback: ${JSON.stringify(state)}`);
}

console.log(`\n[3] After ${PRIMARY_LAPS_BEFORE_FALLBACK} completed primary laps, the cursor genuinely switches to scanning the fallback group...\n`);
{
  const USER = "user-cursor-3";
  const primaryLen = 2;
  const fallbackLen = 3;
  let switchedAtCall = -1;
  for (let i = 1; i <= primaryLen * PRIMARY_LAPS_BEFORE_FALLBACK; i++) {
    advanceCursor(USER, primaryLen, fallbackLen);
    const state = getCursorPosition(USER);
    if (state.scanningFallback && switchedAtCall === -1) switchedAtCall = i;
  }
  const finalState = getCursorPosition(USER);
  assert.equal(finalState.scanningFallback, true, `must be scanning fallback after ${PRIMARY_LAPS_BEFORE_FALLBACK} completed primary laps (${primaryLen * PRIMARY_LAPS_BEFORE_FALLBACK} advances)`);
  assert.equal(finalState.symbolCursor, 0, "cursor resets to 0 when switching into the fallback group");
  console.log(`    real: switched to fallback on advance #${switchedAtCall} (primary has ${primaryLen} symbols, ${PRIMARY_LAPS_BEFORE_FALLBACK} laps = ${primaryLen * PRIMARY_LAPS_BEFORE_FALLBACK} advances)`);
}

console.log("\n[4] After exactly one fallback lap, the cursor returns to primary with primaryLapsCompleted reset...\n");
{
  const USER = "user-cursor-4";
  const primaryLen = 2;
  const fallbackLen = 3;
  // Drive it into fallback mode first.
  for (let i = 0; i < primaryLen * PRIMARY_LAPS_BEFORE_FALLBACK; i++) advanceCursor(USER, primaryLen, fallbackLen);
  assert.equal(getCursorPosition(USER).scanningFallback, true, "sanity: must be in fallback mode before this check");

  // One full fallback lap (fallbackLen advances) must return it to primary.
  for (let i = 0; i < fallbackLen; i++) advanceCursor(USER, primaryLen, fallbackLen);
  const backToPrimary = getCursorPosition(USER);
  assert.equal(backToPrimary.scanningFallback, false, "must return to primary after exactly one fallback lap");
  assert.equal(backToPrimary.symbolCursor, 0, "cursor resets to 0 when returning to primary");
  console.log(`    real state after one fallback lap: ${JSON.stringify(backToPrimary)}`);

  // And it must take another full PRIMARY_LAPS_BEFORE_FALLBACK laps before switching again --
  // proving primaryLapsCompleted genuinely reset, not carried over.
  for (let i = 0; i < (primaryLen * PRIMARY_LAPS_BEFORE_FALLBACK) - 1; i++) advanceCursor(USER, primaryLen, fallbackLen);
  assert.equal(getCursorPosition(USER).scanningFallback, false, "must NOT switch back to fallback early -- primaryLapsCompleted was genuinely reset to 0");
  advanceCursor(USER, primaryLen, fallbackLen);
  assert.equal(getCursorPosition(USER).scanningFallback, true, "must switch to fallback again after a genuine fresh full count of primary laps");
  console.log("    real: primaryLapsCompleted genuinely reset -- took a full fresh count of laps to switch again");
}

console.log("\n=== ALL ASSERTIONS PASSED ===");

rmSync(workDir, { recursive: true, force: true });
process.exit(0);
