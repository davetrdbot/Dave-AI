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

console.log("[1] low/medium stay light -- but must still cover spike, sniper, scalp, the edge and the verdict");
{
  const m = lazyModel(["spike", "sniper", "scalp", "edge", "verdict"]);
  const r = await runSequentialThinking({ provider: m.provider, systemPrompt: "s", contextLines: ["ctx"], effort: "low" });
  assert.deepEqual(r.thoughts.map((t) => t.stage), ["spike", "sniper", "scalp", "edge", "verdict"], "can't stop until the four + verdict are covered");
  assert.ok(!m.prompts[0].includes("bias:"), "light levels don't carry the whole checklist");
  assert.match(m.prompts[0], /Your checklist -- EVERY step is mandatory[\s\S]*spike[\s\S]*sniper[\s\S]*scalp[\s\S]*edge: the advantage/, "even low thinks about spike, sniper, scalp and the advantage");
}
console.log("   ✓\n");

console.log("[2] high: can't stop until every checklist stage is covered, and must argue against itself");
{
  const order = ["bias", "spike", "trigger", "sniper", "scalp", "invalidation", "target", "edge", "counter", "memory", "scenario", "verdict"];
  const m = lazyModel(order);
  const progress: string[] = [];
  const r = await runSequentialThinking({ provider: m.provider, systemPrompt: "s", contextLines: ["ctx"], effort: "high", onProgress: (t) => progress.push(t) });
  assert.deepEqual(r.thoughts.map((t) => t.stage), order, "kept going past the lazy stop until every step (spike, sniper, scalp and edge included) was covered");
  assert.equal(r.missedStages.length, 0);
  assert.match(m.prompts[0], /Your checklist[\s\S]*counter: the strongest case AGAINST this trade/);
  assert.ok(progress.some((p) => p.startsWith("Not done yet -- still to cover:")));
  assert.match(r.summary, /high effort, 12 step\(s\)/);
  assert.match(m.prompts[0], /spike: the spike[\s\S]*sniper: the sniper entry[\s\S]*scalp: the scalp[\s\S]*edge: the advantage/);
  assert.ok(r.thoughts.length <= EFFORT_PROFILES.high.maxThoughts);
}
console.log("   ✓\n");

console.log("[3] high: a model that keeps tagging one stage still gets every step, in order (each thought is assigned its step)");
{
  const m = lazyModel(["verdict"]);
  const r = await runSequentialThinking({ provider: m.provider, systemPrompt: "s", contextLines: ["ctx"], effort: "high" });
  assert.equal(r.missedStages.length, 0, "seen live: 'verdict' eight times while sniper/scalp/edge/memory were never thought -- not any more");
  assert.deepEqual(r.thoughts.map((t) => t.stage), ["bias", "spike", "trigger", "sniper", "scalp", "invalidation", "target", "edge", "counter", "memory", "scenario", "verdict"]);
  assert.match(m.prompts[3], /THIS THOUGHT IS STEP "sniper"/);
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
