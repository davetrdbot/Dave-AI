import assert from "node:assert/strict";
import type { Provider, CompletionRequest, CompletionResult } from "@dave/brain";
import { runSequentialThinking, EFFORT_PROFILES } from "../src/sequential-thinking.js";

/** The trader: "upgrade the sequential thinking so it can think like high -- add efforts". */
console.log("=== Step 182: thinking effort ===\n");

/** A lazy model: covers `stages` in order, then always tries to stop after its 2nd thought. */
function lazyModel(stages: string[], critic?: { weakestPoint: string; holds: boolean }) {
  let n = 0;
  const prompts: string[] = [];
  const provider: Provider = {
    name: "mock",
    generate: async (req: CompletionRequest): Promise<CompletionResult> => {
      const tool = req.tools?.[0]?.name;
      prompts.push(String(req.messages[req.messages.length - 1].content));
      if (tool === "submit_critique") return { text: "", provider: "claude", latencyMs: 1, toolCalls: [{ id: "c", name: tool, arguments: critic ?? { weakestPoint: "x", holds: true } }] };
      const stage = stages[Math.min(n, stages.length - 1)];
      n++;
      return { text: "", provider: "claude", latencyMs: 1, toolCalls: [{ id: `t${n}`, name: "submit_thought", arguments: { thought: `${stage} reasoning with numbers ${n}`, thoughtNumber: n, totalThoughts: 2, nextThoughtNeeded: n < 2, stage } }] };
    },
  };
  return { provider, prompts, calls: () => n };
}

console.log("[1] low/medium stay light");
{
  const m = lazyModel(["bias"]);
  const r = await runSequentialThinking({ provider: m.provider, systemPrompt: "s", contextLines: ["ctx"], effort: "low" });
  assert.equal(r.thoughts.length, 2, "stops when the model says so");
  assert.ok(!m.prompts[0].includes("Your checklist"));
}
console.log("   ✓\n");

console.log("[2] high: can't stop until every checklist stage is covered, and must argue against itself");
{
  const order = ["bias", "trigger", "invalidation", "target", "counter", "memory", "verdict"];
  const m = lazyModel(order);
  const progress: string[] = [];
  const r = await runSequentialThinking({ provider: m.provider, systemPrompt: "s", contextLines: ["ctx"], effort: "high", onProgress: (t) => progress.push(t) });
  assert.deepEqual(r.thoughts.map((t) => t.stage), order, "kept going past the lazy stop until all 7 stages were covered");
  assert.equal(r.missedStages.length, 0);
  assert.match(m.prompts[0], /Your checklist[\s\S]*counter: the strongest case AGAINST this trade/);
  assert.ok(progress.some((p) => p.startsWith("Not done yet -- still to cover:")));
  assert.match(r.summary, /high effort, 7 step\(s\)/);
  assert.ok(r.thoughts.length <= EFFORT_PROFILES.high.maxThoughts);
}
console.log("   ✓\n");

console.log("[3] high: a model stuck on one stage is bounded, and the gap is reported honestly");
{
  const m = lazyModel(["bias"]);
  const r = await runSequentialThinking({ provider: m.provider, systemPrompt: "s", contextLines: ["ctx"], effort: "high" });
  assert.equal(r.thoughts.length, EFFORT_PROFILES.high.maxThoughts);
  assert.ok(r.missedStages.includes("counter"));
  assert.match(r.summary, /never reached: .*counter/);
  assert.match(m.prompts[m.prompts.length - 1], /Running out of thoughts -- cover what's still missing now/);
}
console.log("   ✓\n");

console.log("[4] max: all 8 stages, then an independent critic, then one answer to it");
{
  const m = lazyModel(["bias", "trigger", "invalidation", "target", "counter", "memory", "scenario", "verdict"], { weakestPoint: "the stop sits inside the M15 range -- noise will take it", holds: false });
  const r = await runSequentialThinking({ provider: m.provider, systemPrompt: "s", contextLines: ["ctx"], effort: "max" });
  assert.equal(r.critique?.holds, false);
  const last = r.thoughts[r.thoughts.length - 1];
  assert.equal(last.answersCritic, true);
  assert.match(m.prompts[m.prompts.length - 1], /A SCEPTICAL REVIEWER SAYS the weakest link is: "the stop sits inside the M15 range/);
  assert.match(r.summary, /critic says the conclusion does NOT hold/);
}
console.log("   ✓\n");

console.log("[5] the whole pass respects its time budget");
{
  const m = lazyModel(["bias"]);
  let t = 0;
  const r = await runSequentialThinking({ provider: m.provider, systemPrompt: "s", contextLines: ["ctx"], effort: "max", now: () => (t += 100_000) });
  assert.ok(r.thoughts.length < EFFORT_PROFILES.max.maxThoughts, `stopped on the clock after ${r.thoughts.length}`);
}
console.log("   ✓\n");
console.log("All Step 182 checks passed.");
process.exit(0);
