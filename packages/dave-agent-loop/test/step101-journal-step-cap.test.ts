import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import type { Provider, CompletionRequest, CompletionResult, ToolCall } from "@dave/brain";
import { consultJournal } from "../src/journal-agent.js";

/**
 * Real bug fixed (caught live: a stuck autonomous cycle turned out to be a container restart
 * racing a busy-flag staleness window -- but auditing that also surfaced a real, separate design
 * gap: Journal's own AgentLoop.run() had no step cap at all, unlike everything else in the
 * autonomous tick, which is deliberately bounded. A consult happens INSIDE a single tick, so an
 * unbounded Journal exploration (repeatedly calling tools without ever answering in plain text)
 * could otherwise block the whole cycle indefinitely. Proves consultJournal genuinely returns an
 * honest opinion once its step cap is hit, instead of hanging or throwing.
 */

console.log("=== Real proof: Journal's own consult is genuinely bounded, never an unbounded loop ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-journal-step-cap-"));
process.chdir(workDir);

async function main() {
  const db = new DaveDatabase(join(workDir, "dave.db"));

  let calls = 0;
  const stubbornProvider: Provider = {
    name: "mock",
    generate: async (req: CompletionRequest): Promise<CompletionResult> => {
      calls++;
      // Always calls a real tool, never answers in plain text -- would loop forever without a cap.
      const firstTool = req.tools?.[0];
      const toolCalls: ToolCall[] = firstTool ? [{ id: `c${calls}`, name: firstTool.name, arguments: { symbol: "EURUSD" } }] : [];
      return { text: "", provider: "mock", latencyMs: 1, toolCalls };
    },
  };

  console.log("[1] Journal never answers in plain text -- consultJournal must still return, not hang...\n");
  const result = await consultJournal({ userId: "user-journal-cap-1", db, provider: stubbornProvider }, "What do you think of this setup?");
  assert.ok(result.opinion, "a real opinion string must always come back, even when the step cap is hit");
  assert.ok(calls <= 6, `must genuinely stop within a small, bounded number of calls, not loop forever (got ${calls} calls)`);
  console.log(`    confirmed: consultJournal returned after ${calls} real calls: "${result.opinion}"`);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
}

main()
  .then(() => {
    rmSync(workDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    rmSync(workDir, { recursive: true, force: true });
    console.error(err);
    process.exit(1);
  });
