import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider, CompletionRequest, CompletionResult } from "@dave/brain";

/**
 * The trader (1 Oct): thinking steps the trader can switch on/off, delete and add (every one
 * mandatory); no thinking pass on alert/reminder scans unless switched on; the APA strategy as a
 * skill; setup drawings that teach the strategy, not just label it.
 */

const workDir = mkdtempSync(join(tmpdir(), "dave-step198-"));
process.env.DAVE_DATA_ROOT = workDir;
const trading = await import("@dave/trading");
const skills = await import("@dave/skills");
const { runSequentialThinking } = await import("../src/sequential-thinking.js");
const { parseDrawing } = await import("../src/setup-drawing.js");

try {
  console.log("[1] Steps: switch off, delete, add your own -- and the thinking pass must cover every one that's on\n");
  const U = "steps-user";
  assert.ok(trading.getThinkingStages(U).some((s: { id: string }) => s.id === "growth"), "growth is a built-in step");
  trading.setThinkingStageEnabled(U, "scalp", false);
  trading.deleteThinkingStage(U, "scenario");
  trading.addThinkingStage(U, "News", "is a high-impact news event due in the next hour");
  const enabled = trading.getEnabledThinkingStages(U) as { id: string; help: string }[];
  const ids = enabled.map((s) => s.id);
  assert.ok(!ids.includes("scalp") && !ids.includes("scenario"));
  assert.equal(ids[ids.length - 1], "verdict", "a new step goes before the verdict");
  assert.ok(ids.includes("news"));
  assert.throws(() => trading.addThinkingStage(U, "", "x"), /name/);

  // A lazy model that tries to stop after 2 thoughts, then covers whatever it is asked for.
  let n = 0;
  const prompts: string[] = [];
  const provider: Provider = {
    name: "mock",
    generate: async (req: CompletionRequest): Promise<CompletionResult> => {
      const tool = req.tools?.[0]?.name;
      const text = String(req.messages[req.messages.length - 1].content);
      prompts.push(text);
      if (tool === "submit_critique") return { text: "", provider: "claude", latencyMs: 1, toolCalls: [{ id: "c", name: tool, arguments: { weakestPoint: "x", holds: true } }] };
      const stage = ids[Math.min(n, ids.length - 1)];
      n++;
      return { text: "", provider: "claude", latencyMs: 1, toolCalls: [{ id: `t${n}`, name: "submit_thought", arguments: { thought: `${stage} ${n}`, thoughtNumber: n, totalThoughts: 2, nextThoughtNeeded: n < 2, stage } }] };
    },
  };
  const r = await runSequentialThinking({ provider, systemPrompt: "s", contextLines: ["ctx"], effort: "high", stages: enabled });
  assert.deepEqual(r.thoughts.map((t) => t.stage), ids, "every enabled step covered, in spite of the lazy stop");
  assert.match(prompts[0], /- news: is a high-impact news event due/, "the trader's own step is in the checklist");
  assert.ok(!/- scalp:/.test(prompts[0]), "a step switched off is not");
  const light = await runSequentialThinking({ provider: { ...provider }, systemPrompt: "s", contextLines: ["ctx"], effort: "low", stages: enabled }).catch(() => null);
  assert.ok(light, "low runs with custom steps too");
  trading.resetThinkingStages(U);
  assert.equal(trading.getThinkingStages(U).length, trading.DEFAULT_THINKING_STAGES.length);
  console.log("   ✓\n");

  console.log("[2] Thinking on alert scans: off by default, switchable\n");
  assert.equal(trading.getThinkOnAlertScans(U), false);
  trading.setThinkOnAlertScans(U, true);
  assert.equal(trading.getThinkOnAlertScans(U), true);
  console.log("   ✓\n");

  console.log("[3] The APA skill is on every account, with all seven entry models\n");
  const skill = skills.seedApaSkill(U) as { name: string; content: string };
  for (const m of ["OCL buy", "OCL sell", "Resistance \"A\"", "Support \"V\"", "SBR", "RBS", "QM"]) assert.ok(skill.content.includes(m), m);
  assert.equal((skills.seedApaSkill(U) as { name: string }).name, skill.name, "seeding twice keeps one");
  assert.equal(skills.listSkills(U).filter((s: { name: string }) => s.name === skill.name).length, 1);
  console.log("   ✓\n");

  console.log("[4] A drawing teaches the strategy: numbered story on the chart, explained under it\n");
  const candles = Array.from({ length: 10 }, (_, i) => ({ o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i }));
  const d = parseDrawing({
    title: "OCL buy on VOL_75",
    candles,
    strategy: "APA OCL buy: the H4 open-close line nearest the last bullish BOS, fresh, with sell-side liquidity under it.",
    story: [
      { index: 2, price: 103, label: "BOS", why: "bias is up" },
      { index: 4, price: 104, label: "OCL key level", why: "fresh, nearest the BOS" },
      { index: 6, price: 103.5, label: "Sweep", why: "early buyers' stops taken" },
      { index: 7, price: 105, label: "CHoCH M5", why: "confirmation" },
    ],
  });
  assert.deepEqual(d.notes.slice(0, 4).map((x: { text: string }) => x.text), ["1 BOS", "2 OCL key level", "3 Sweep", "4 CHoCH M5"]);
  assert.match(d.caption!, /^APA OCL buy[\s\S]*1\. BOS -- bias is up[\s\S]*4\. CHoCH M5 -- confirmation/);
  console.log("   ✓\n");

  console.log("=== step198: ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
process.exit(0);
