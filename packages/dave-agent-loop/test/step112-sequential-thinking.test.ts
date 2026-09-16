import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider, CompletionRequest, CompletionResult, ToolCall } from "@dave/brain";
import { getSequentialThinkingEnabled, setSequentialThinkingEnabled, resetRiskSettingsForUser } from "@dave/trading";
import { runSequentialThinking, MAX_SEQUENTIAL_THOUGHTS } from "../src/sequential-thinking.js";

// --- [0] The real settings toggle (risk-settings.ts, same file-backed pattern as two-step
// trading/Flo): defaults OFF, and a real round trip persists. ---
console.log("[0] getSequentialThinkingEnabled/setSequentialThinkingEnabled -- OFF by default, real round trip...\n");
const workDir = mkdtempSync(join(tmpdir(), "dave-sequential-thinking-toggle-"));
process.chdir(workDir);
const OWNER = "user-seq-thinking-1";
assert.equal(getSequentialThinkingEnabled(OWNER), false, "must default OFF -- an explicit opt-in given the real extra token/latency cost");
setSequentialThinkingEnabled(OWNER, true);
assert.equal(getSequentialThinkingEnabled(OWNER), true, "a real toggle-on must persist");
setSequentialThinkingEnabled(OWNER, false);
assert.equal(getSequentialThinkingEnabled(OWNER), false, "a real toggle-off must persist too");
setSequentialThinkingEnabled(OWNER, true);
resetRiskSettingsForUser(OWNER);
assert.equal(getSequentialThinkingEnabled(OWNER), false, "/reset must genuinely clear it back to the real OFF default, same as two-step trading");
console.log("    confirmed: OFF by default, persists both ways, and /reset genuinely clears it\n");

/**
 * Real proof for Part 3: a focused sequential-thinking pass (adapted from the MCP
 * "sequential-thinking" reference server's numbered/revisable-thought technique), scoped to
 * exactly one bounded pre-pass, real per-thought progress callbacks, and a hard cap on real extra
 * model round trips -- the real cost/latency tradeoff this feature is opt-in specifically because of.
 */

console.log("=== Step 112 real proof: sequential-thinking pass (Part 3) -- bounded, numbered, ===");
console.log("=== revisable real reasoning steps ahead of ONE trade decision ===\n");

function fakeThoughtProvider(scriptedThoughts: { thought: string; totalThoughts: number; nextThoughtNeeded: boolean; isRevision?: boolean; revisesThought?: number }[]): Provider {
  let call = 0;
  return {
    name: "groq",
    generate: async (_req: CompletionRequest): Promise<CompletionResult> => {
      const t = scriptedThoughts[Math.min(call, scriptedThoughts.length - 1)];
      call++;
      const toolCall: ToolCall = {
        id: `call_${call}`,
        name: "submit_thought",
        arguments: {
          thought: t.thought,
          thoughtNumber: call,
          totalThoughts: t.totalThoughts,
          nextThoughtNeeded: t.nextThoughtNeeded,
          isRevision: t.isRevision,
          revisesThought: t.revisesThought,
        },
      };
      return { text: "", provider: "groq", latencyMs: 1, toolCalls: [toolCall] };
    },
  };
}

// --- [1] A model that reasons through 3 real thoughts, then stops on its own. ---
console.log("[1] A real 3-thought sequence, model-driven stop (nextThoughtNeeded: false)...\n");
const progress: string[] = [];
const provider1 = fakeThoughtProvider([
  { thought: "EURUSD swept the Asian low, first real liquidity grab of the session.", totalThoughts: 3, nextThoughtNeeded: true },
  { thought: "M5 shows a bullish FVG reclaiming structure right above the sweep -- real confluence with the sweep, not just a bounce.", totalThoughts: 3, nextThoughtNeeded: true },
  { thought: "RSI diverged bullish off the sweep low too -- three independent signals now agree, that's enough to commit.", totalThoughts: 3, nextThoughtNeeded: false },
]);
const result1 = await runSequentialThinking({
  provider: provider1,
  systemPrompt: "You are Dave.",
  contextLines: ["SYMBOL: EURUSD", "PRICE: {}"],
  onProgress: (text) => progress.push(text),
});
console.log(`    thoughts: ${result1.thoughts.length}, summary: "${result1.summary.slice(0, 140)}..."`);
assert.equal(result1.thoughts.length, 3, "must stop exactly when the model sets nextThoughtNeeded: false, not run to the cap");
assert.equal(result1.thoughts[2].nextThoughtNeeded, false);
assert.equal(progress.length, 3, "onProgress must fire once per real thought");
assert.ok(progress[0].includes("Thought 1/3"), "progress text must be a real, readable per-thought update");
assert.ok(result1.summary.includes("SEQUENTIAL THINKING TRACE"), "the summary must be clearly labeled for the decision prompt it gets appended to");
assert.ok(result1.summary.includes("sweep"), "the real thought content must be genuinely present in the summary, not paraphrased away");
console.log("    confirmed: stops on the model's own signal, real progress reported per thought\n");

// --- [2] Revision support (a later thought can explicitly reconsider an earlier one). ---
console.log("[2] A later thought explicitly revises an earlier one...\n");
const provider2 = fakeThoughtProvider([
  { thought: "Looks like a clean BUY setup off the sweep.", totalThoughts: 2, nextThoughtNeeded: true },
  { thought: "Wait -- the H4 trend is actually still bearish, that sweep is just noise inside a larger downtrend. Revising: this isn't a real setup.", totalThoughts: 2, nextThoughtNeeded: false, isRevision: true, revisesThought: 1 },
]);
const result2 = await runSequentialThinking({ provider: provider2, systemPrompt: "You are Dave.", contextLines: ["SYMBOL: XAUUSD"] });
assert.equal(result2.thoughts[1].isRevision, true);
assert.equal(result2.thoughts[1].revisesThought, 1);
assert.ok(result2.summary.includes("revises thought 1"), "a real revision must be visible in the trace, not silently dropped");
console.log(`    thought 2 explicitly revises thought 1: "${result2.thoughts[1].thought.slice(0, 60)}..."`);
console.log("    confirmed: revision is a real, visible part of the trace\n");

// --- [3] Hard cap: a model that NEVER stops on its own is still bounded -- this is the real ---
// --- cost/latency ceiling the toggle's tradeoff depends on. ---
console.log(`[3] A model that never sets nextThoughtNeeded: false is still hard-capped at ${MAX_SEQUENTIAL_THOUGHTS} real thoughts...\n`);
let neverStopsCalls = 0;
const neverStopsProvider: Provider = {
  name: "groq",
  generate: async () => {
    neverStopsCalls++;
    return {
      text: "",
      provider: "groq",
      latencyMs: 1,
      toolCalls: [{ id: `c${neverStopsCalls}`, name: "submit_thought", arguments: { thought: `thought ${neverStopsCalls}`, thoughtNumber: neverStopsCalls, totalThoughts: 99, nextThoughtNeeded: true } }],
    };
  },
};
const result3 = await runSequentialThinking({ provider: neverStopsProvider, systemPrompt: "You are Dave.", contextLines: ["SYMBOL: GBPUSD"] });
console.log(`    real model calls made: ${neverStopsCalls}, thoughts collected: ${result3.thoughts.length}`);
assert.equal(neverStopsCalls, MAX_SEQUENTIAL_THOUGHTS, "must make exactly MAX_SEQUENTIAL_THOUGHTS real provider calls, never more -- this is the real cost/latency ceiling");
assert.equal(result3.thoughts.length, MAX_SEQUENTIAL_THOUGHTS);
console.log("    confirmed: bounded cost -- a runaway model can never turn this into an unbounded number of real calls\n");

// --- [4] A failing provider call is swallowed -- the real trade decision that follows must ---
// --- never be blocked by a broken thinking pass. ---
console.log("[4] A failing provider call is swallowed, not thrown -- must never block the real trade decision...\n");
const flakyProvider: Provider = {
  name: "groq",
  generate: async () => {
    throw new Error("simulated real provider outage");
  },
};
const result4 = await runSequentialThinking({ provider: flakyProvider, systemPrompt: "You are Dave.", contextLines: ["SYMBOL: USDJPY"] });
assert.equal(result4.thoughts.length, 0);
assert.equal(result4.summary, "", "no real thoughts means no summary line appended to the decision prompt -- honest about having nothing to add");
console.log("    confirmed: a broken thinking pass fails safe, contributes nothing rather than blocking or crashing\n");

console.log("=== ALL ASSERTIONS PASSED ===");
