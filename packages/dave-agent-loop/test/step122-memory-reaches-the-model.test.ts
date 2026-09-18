import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Real bug fixed (the trader, explicit: "don't forget to check the memory"). Dave's memory was
 * write-only in practice: remember_user_fact / remember_note / remember_adaptability_note all
 * genuinely persisted to disk, and prompts/BOOTSTRAP.md tells the model those saves are
 * mandatory -- but loadFrozenSnapshot had exactly two callers in the entire codebase, the
 * recall_memory TOOL and a selftest. Nothing loaded memory into the system prompt or into any
 * turn, so "remember I hate XAUUSD" was saved and then never seen again unless the model
 * spontaneously chose to call recall_memory first.
 *
 * This proves the memory a user asked Dave to keep genuinely reaches the model on the very next
 * turn, with no tool call required.
 */

const workDir = mkdtempSync(join(tmpdir(), "dave-memory-context-"));
process.env.DAVE_DATA_ROOT = workDir;
const USER = "user-memory-ctx-1";

const memoryDir = join(workDir, "data", "memory", USER);
mkdirSync(memoryDir, { recursive: true });

console.log("=== Real proof: what Dave remembers actually reaches the model, unprompted ===\n");

try {
  // Written the same way the real remember_* tools write them -- real files, real store layout.
  writeFileSync(join(memoryDir, "MEMORY.md"), "# Memory\n\n- The trader does NOT day-trade. Never assume intraday holding periods.\n", "utf8");
  writeFileSync(join(memoryDir, "USER.md"), "# User\n\n- Name: Inyang David\n- Trades synthetic indices on Headway, not forex majors.\n", "utf8");
  writeFileSync(join(memoryDir, "ADAPTABILITY.md"), "# Adaptability\n\n- Dislikes long, dense explanations. Keep replies short.\n", "utf8");

  const { buildLiveSettingsBlock } = await import("../src/live-context.js");
  const block = buildLiveSettingsBlock(USER);

  console.log("[1] The per-turn context genuinely carries a remembered block...\n");
  assert.match(block, /<remembered>/, "the live context must genuinely include the remembered block");
  console.log("    confirmed: <remembered> present in the block the model actually receives");

  console.log("\n[2] Every real memory file's content is genuinely in it -- not just one...\n");
  assert.match(block, /does NOT day-trade/, "MEMORY.md content must genuinely reach the model");
  assert.match(block, /Inyang David/, "USER.md content must genuinely reach the model");
  assert.match(block, /Keep replies short/, "ADAPTABILITY.md content must genuinely reach the model");
  console.log("    confirmed: MEMORY.md, USER.md and ADAPTABILITY.md content all present");

  console.log("\n[3] The model is told to treat it as already known, so it stops re-asking...\n");
  assert.match(block, /never ask them to repeat something recorded here/i, "the instruction that fixes the real symptom must be present");
  console.log("    confirmed: the 'already known, never re-ask' instruction rides along with it");

  console.log("\n[4] A user with genuinely no memory yet gets NO empty block -- no wasted tokens...\n");
  const EMPTY_USER = "user-memory-ctx-empty";
  const emptyBlock = buildLiveSettingsBlock(EMPTY_USER);
  assert.doesNotMatch(emptyBlock, /<remembered>/, "a user with no memories must not get an empty remembered block every single turn");
  assert.match(emptyBlock, /<current_settings>/, "the rest of the live context must still be built normally");
  console.log("    confirmed: no memories means no block at all, and the rest of the context is unaffected");

  console.log("\n[5] Corrupt memory must never take down a real trading turn...\n");
  const BROKEN_USER = "user-memory-ctx-broken";
  const brokenDir = join(workDir, "data", "memory", BROKEN_USER);
  mkdirSync(brokenDir, { recursive: true });
  // A directory where a file is expected -- exactly the shape a crash mid-write can leave behind,
  // and this process has genuinely been crashing.
  mkdirSync(join(brokenDir, "MEMORY.md"), { recursive: true });
  const brokenBlock = buildLiveSettingsBlock(BROKEN_USER);
  assert.match(brokenBlock, /<current_settings>/, "an unreadable memory store must degrade, never throw and kill the turn");
  console.log("    confirmed: unreadable memory degrades safely -- the turn still gets its full settings context");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
