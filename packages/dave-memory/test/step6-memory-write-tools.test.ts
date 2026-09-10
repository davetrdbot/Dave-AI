import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMORY_WRITE_TOOLS } from "../src/write-tools.js";
import { readLive } from "../src/hermes-store.js";
import { setWriteApprovalSetting } from "../src/write-approval.js";

/**
 * Real proof for item 11 (user: "the tools that let Dave write to USER.md, MEMORY.md,
 * ADAPTABILITY.md appear to have been removed"). Direct investigation found something deeper than
 * a CORE-list omission: appendUserFact/appendAdaptability/appendMemoryNote were real writer
 * functions, but the ONLY caller anywhere was dave-core/bootstrap.ts's one-time onboarding flow --
 * there was never an agent-callable tool wrapping them. This proves the new tools genuinely write
 * to disk, genuinely honor the write-approval gate, and are genuinely callable by name.
 */

console.log("=== Real proof: memory-write tools genuinely exist, are callable, and write to disk ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-memory-write-tools-"));
process.chdir(workDir);
const USER = "user-1";

function findTool(name: string) {
  const tool = MEMORY_WRITE_TOOLS.find((t) => t.name === name);
  assert.ok(tool, `MEMORY_WRITE_TOOLS must contain "${name}"`);
  return tool!;
}

console.log("[1] remember_user_fact writes a real fact to USER.md...\n");
const userFactTool = findTool("remember_user_fact");
const r1: any = await userFactTool.execute({ fact: "Trades EURUSD and XAUUSD mainly, London session." }, { actorId: USER });
assert.equal(r1.applied, true);
const userMd = readLive(USER, "USER.md");
assert.ok(userMd.includes("Trades EURUSD and XAUUSD mainly, London session."), "the real fact must genuinely be on disk in USER.md");
console.log(`    USER.md now contains: ${JSON.stringify(userMd)}`);

console.log("\n[2] remember_note writes a real note to MEMORY.md...\n");
const memoryNoteTool = findTool("remember_note");
const r2: any = await memoryNoteTool.execute({ note: "User declined the 3rd hunt-mode candidate on 2026-09-10 -- too correlated with an open position." }, { actorId: USER });
assert.equal(r2.applied, true);
const memoryMd = readLive(USER, "MEMORY.md");
assert.ok(memoryMd.includes("too correlated with an open position."), "the real note must genuinely be on disk in MEMORY.md");
console.log(`    MEMORY.md now contains: ${JSON.stringify(memoryMd)}`);

console.log("\n[3] remember_adaptability_note writes a real preference to ADAPTABILITY.md...\n");
const adaptTool = findTool("remember_adaptability_note");
const r3: any = await adaptTool.execute({ note: "Prefers short, direct trade summaries -- no filler." }, { actorId: USER });
assert.equal(r3.applied, true);
const adaptMd = readLive(USER, "ADAPTABILITY.md");
assert.ok(adaptMd.includes("Prefers short, direct trade summaries -- no filler."), "the real note must genuinely be on disk in ADAPTABILITY.md");
console.log(`    ADAPTABILITY.md now contains: ${JSON.stringify(adaptMd)}`);

console.log("\n[4] With write-approval mode ON, a write is genuinely queued, NOT applied immediately...\n");
setWriteApprovalSetting(USER, true);
const beforeGate = readLive(USER, "USER.md");
const r4: any = await userFactTool.execute({ fact: "This fact must NOT land immediately." }, { actorId: USER });
assert.equal(r4.applied, false);
assert.ok(r4.pendingId, "a gated write must return a real pendingId");
const afterGate = readLive(USER, "USER.md");
assert.equal(afterGate, beforeGate, "USER.md must be genuinely unchanged while the write is pending approval");
console.log(`    real gated result: ${JSON.stringify(r4)} -- USER.md genuinely unchanged until approved`);
setWriteApprovalSetting(USER, false);

console.log("\n=== ALL ASSERTIONS PASSED ===");
rmSync(workDir, { recursive: true, force: true });
process.exit(0);
