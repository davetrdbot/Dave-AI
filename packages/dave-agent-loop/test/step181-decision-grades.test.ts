import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider, CompletionRequest, CompletionResult } from "@dave/brain";
import { recordDecisionForGrading, gradeDecision, listGradedDecisions, pastCallsBlock, gradeStats, listNeurons, setMinRiskReward } from "@dave/trading";
import { settleDueDecisions, parseCandles } from "../src/decision-grading.js";

/** Grading Dave's calls -- skips too -- against what price did next. */
console.log("=== Step 181: graded calls ===\n");
const dir = mkdtempSync(join(tmpdir(), "dave-grades-"));
process.chdir(dir);
process.env.DAVE_DATA_ROOT = dir;
const U = "g";
const M15 = 15 * 60_000;
const T0 = Date.UTC(2026, 8, 29, 8, 0);

// Bars: flat at 100 until the decision bar, then a rally to 104.5 (ATR 1 -> +4.5 ATR), never dipping 1 ATR.
const bar = (i: number, o: number, h: number, l: number, c: number) => ({ t: T0 + i * M15, o, h, l, c });
const rally = [bar(0, 100, 100.3, 99.8, 100), bar(1, 100, 101, 99.6, 100.9), bar(2, 100.9, 102.2, 100.5, 102), bar(3, 102, 104.5, 101.8, 104.2), ...Array.from({ length: 6 }, (_, k) => bar(4 + k, 104, 104.4, 103.8, 104))];
const dump = [bar(0, 100, 100.2, 99.9, 100), bar(1, 100, 100.1, 98.8, 99), ...Array.from({ length: 8 }, (_, k) => bar(2 + k, 99, 99.2, 98.7, 99))];

console.log("[1] The maths: which side reached 2R before a 1R stop");
const at = T0 + 5 * 60_000;
assert.equal(gradeDecision({ at, action: "SKIP", direction: null }, rally, 1, 2, M15)?.verdict, "missed_long");
assert.equal(gradeDecision({ at, action: "BUY", direction: "long" }, rally, 1, 2, M15)?.verdict, "good_call");
assert.equal(gradeDecision({ at, action: "SELL", direction: "short" }, rally, 1, 2, M15)?.verdict, "bad_call");
assert.equal(gradeDecision({ at, action: "BUY", direction: "long" }, dump, 1, 2, M15)?.verdict, "bad_call");
assert.equal(gradeDecision({ at, action: "SKIP", direction: null }, dump, 1, 2, M15)?.verdict, "good_skip", "a 1-ATR drop is only half the 2R target");
assert.equal(gradeDecision({ at, action: "SKIP", direction: null }, rally.slice(0, 4), 1, 2, M15), null, "window not covered yet -> no verdict");
const g = gradeDecision({ at, action: "SKIP", direction: null }, rally, 1, 2, M15)!;
assert.equal(g.upAtr, 4.5);
console.log("   ✓\n");

console.log("[2] Recording: one call per pair per half hour; ASK/PAUSE are not calls");
assert.ok(recordDecisionForGrading(U, { symbol: "xauusd", action: "SKIP", reason: "RSI mid, no structure" }, at));
assert.equal(recordDecisionForGrading(U, { symbol: "XAUUSD", action: "SKIP", reason: "again" }, at + 5 * 60_000), null);
assert.ok(recordDecisionForGrading(U, { symbol: "EURUSD", action: "BUY", reason: "H1 demand", confidence: 72 }, at));
assert.equal(recordDecisionForGrading(U, { symbol: "EURUSD", action: "PAUSE", reason: "x" }, at), null);
assert.equal(listGradedDecisions(U).length, 2);
console.log("   ✓\n");

console.log("[3] Settling: candles from the EA, a lesson for the miss, filed into the brain");
setMinRiskReward(U, 2);
const toEa = (bars: typeof rally) => [...bars].reverse().map((b) => ({ t: new Date(b.t).toISOString(), o: b.o, h: b.h, l: b.l, c: b.c, size_vs_atr: (b.h - b.l) / 1 }));
assert.equal(parseCandles(toEa(rally)).atr, 1);
const asked: string[] = [];
const analysis = { get: async <T,>(endpoint: string, symbol: string, tf: string): Promise<T> => (asked.push(`${endpoint} ${symbol} ${tf}`), toEa(symbol === "XAUUSD" ? rally : dump) as T) };
let prompt = "";
const provider: Provider = {
  name: "mock",
  generate: async (req: CompletionRequest): Promise<CompletionResult> => {
    prompt = String(req.messages[1].content);
    const ids = [...prompt.matchAll(/\[([a-f0-9]{10})\]/g)].map((m) => m[1]);
    return { text: "", provider: "claude", latencyMs: 1, toolCalls: [{ id: "x", name: "submit_lessons", arguments: { items: ids.map((id) => ({ id, neuron: "structure", lesson: "Gold broke the Asian high with momentum -- a mid RSI was not a reason to sit out a clean breakout." })) } }] };
  },
};
const r = await settleDueDecisions({ userId: U, analysis, provider, now: at + 2.5 * 3_600_000 });
assert.deepEqual(asked.sort(), ["candles EURUSD M15", "candles XAUUSD M15"]);
assert.equal(r.settled.length, 2);
const byS = Object.fromEntries(listGradedDecisions(U).map((d) => [d.symbol, d]));
assert.equal(byS.XAUUSD.verdict, "missed_long");
assert.equal(byS.EURUSD.verdict, "bad_call");
assert.match(prompt, /Your reason then: "RSI mid, no structure"/);
assert.equal(r.lessons, 2);
assert.match(byS.XAUUSD.lesson ?? "", /Asian high/);
assert.ok(listNeurons(U).find((n) => n.id === "structure")!.facts.some((f) => f.text.startsWith("XAUUSD:")));
console.log("   ✓\n");

console.log("[4] What Dave sees next time he scans gold, and the stats");
const block = pastCallsBlock(U, "XAUUSD")!;
assert.match(block, /YOUR LAST CALLS ON XAUUSD/);
assert.match(block, /SKIP: missed a long -- price ran \+2R/);
assert.match(block, /Lessons from other pairs:\n- EURUSD BUY:/);
const st = gradeStats(U, 30 * 86_400_000, at + 3 * 3_600_000);
assert.deepEqual([st.skips, st.missed, st.calls, st.badCalls, st.skipAccuracyPct], [1, 1, 1, 1, 0]);
console.log(block.split("\n").map((l) => "   " + l).join("\n"));

console.log("\n[5] Too old to grade -> expired, no EA request");
recordDecisionForGrading(U, { symbol: "GBPUSD", action: "SKIP", reason: "x" }, at);
const r2 = await settleDueDecisions({ userId: U, analysis, now: at + 30 * 3_600_000 });
assert.equal(r2.expired, 1);
console.log("   ✓\n");
console.log("All Step 181 checks passed.");
process.exit(0);
