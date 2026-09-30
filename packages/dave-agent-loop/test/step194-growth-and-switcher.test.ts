import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The trader's round of live testing (30 Sep): switching Claude -> Ollama left the scanner waiting
 * out Claude's back-off; a winning trade was flagged "52% toward its SL"; and the self-improvement
 * check found Dave learning from trades he didn't make, an "avoid this pair" that wasn't enforced,
 * and lessons lost when the AI was busy.
 */

const workDir = mkdtempSync(join(tmpdir(), "dave-step194-"));
process.chdir(workDir);
process.env.DAVE_DATA_ROOT = join(workDir, "data");

const { activeAiOutage, markAiOutage, aiSetupFingerprint } = await import("../src/ai-outage.js");
const { asksForShownTradeData } = await import("../src/autonomous-tick.js");
const { loadGrowthTrades } = await import("../src/growth-reflection.js");
const { settleDueDecisions } = await import("../src/decision-grading.js");
const { slProgress } = await import("../src/trade-monitor-store.js");
const bridge = await import("@dave/ea-bridge");
const trading = await import("@dave/trading");

try {
  console.log("[1] Changing the AI clears the scan pause at once\n");
  const U = "outage-user";
  const claude = aiSetupFingerprint({ primary: "claude", fallback: [] }, () => [{ id: "k1", model: "claude-sonnet" }]);
  const ollama = aiSetupFingerprint({ primary: "ollamacloud", fallback: [] }, () => [{ id: "k2", model: "kimi-k2.6" }]);
  const now = Date.now();
  markAiOutage(U, new Error("HTTP 401 invalid api key"), now, claude);
  assert.ok(activeAiOutage(U, now + 1000, claude), "same AI: still paused");
  assert.equal(activeAiOutage(U, now + 1000, ollama), undefined, "switched to Ollama: the pause is gone");
  assert.equal(activeAiOutage(U, now + 1000, claude), undefined, "and it stays gone");
  console.log("   ✓\n");

  console.log("[2] A trade in profit is never 'heading for its stop'\n");
  // SELL at 100, SL 110: price 95 is profit, 106 is 60% of the way to the stop.
  assert.equal(slProgress({ openPrice: 100, sl: 110 }, 95), 0);
  assert.equal(slProgress({ openPrice: 100, sl: 110 }, 106)?.toFixed(2), "0.60");
  console.log("   ✓\n");

  console.log("[3] A scan question about data it already has is recognised\n");
  assert.equal(asksForShownTradeData("What is the entry price for ticket #1236561630 (STORM_500 SELL) so I can set its stop to breakeven?"), true);
  assert.equal(asksForShownTradeData("Need trade details to decide on stop adjustment"), true);
  assert.equal(asksForShownTradeData("You said only synthetics today -- do you want me to scan EURUSD as well?"), false);
  console.log("   ✓\n");

  console.log("[4] Dave's score counts only his own calls\n");
  const G = "growth-user";
  const pos = (ticket: string, extra: Record<string, unknown>) => ({ ticket, symbol: "VOL_10", type: "buy" as const, lots: 0.1, openPrice: 100, ...extra });
  const opened = bridge.deriveTradeEvents({
    previous: [],
    current: [pos("1", { byDave: true }), pos("2", { byDave: false }), pos("3", { byDave: true, comment: "Nous signal" })],
    closedPositions: [],
    daveClosed: new Set(),
    isFirstReport: false,
  });
  bridge.appendTradeEvents(G, opened);
  const closed = bridge.deriveTradeEvents({
    previous: [pos("1", { byDave: true, pnl: 5 }), pos("2", { byDave: false, pnl: -3 }), pos("3", { byDave: true, comment: "Nous signal", pnl: 2 })],
    current: [],
    closedPositions: [
      { ticket: "1", symbol: "VOL_10", pnl: 5, reason: "tp" },
      { ticket: "2", symbol: "VOL_10", pnl: -3, reason: "manual" },
      { ticket: "3", symbol: "VOL_10", pnl: 2, reason: "tp" },
    ] as never,
    daveClosed: new Set(),
    isFirstReport: false,
  });
  bridge.appendTradeEvents(G, closed);
  assert.deepEqual(loadGrowthTrades(G).map((t) => t.ticket), ["1"], "the hand-opened and the copied trade are left out");
  console.log("   ✓\n");

  console.log("[5] 'Leave this pair alone' is known to the code, not just the prompt\n");
  const A = "avoid-user";
  const s = trading.getStrategyState(A);
  s.avoidSymbols.push({ symbol: "BOOM_200", addedInV: 2 });
  trading.saveStrategyState(A, s);
  assert.equal(trading.isSymbolAvoided(A, "boom_200"), true);
  assert.equal(trading.isSymbolAvoided(A, "VOL_10"), false);
  const tool = trading.TRADING_TOOLS?.find?.((t: { name: string }) => t.name === "trade_execute");
  if (tool) {
    await assert.rejects(tool.execute({ symbol: "BOOM_200", type: "buy", lots: 0.1, confidence: 80, reason: "x" }, { userId: A } as never), /leave-alone/);
  }
  console.log("   ✓\n");

  console.log("[6] A lesson the AI couldn't write is retried next run\n");
  const L = "lesson-user";
  const t0 = Date.now() - 3 * 3_600_000;
  const d = trading.recordDecisionForGrading(L, { symbol: "VOL_10", action: "SKIP", reason: "no setup" }, t0)!;
  // 2h later price ran up strongly: a missed long.
  const bars = Array.from({ length: 12 }, (_, i) => ({ t: new Date(t0 + i * 15 * 60_000).toISOString(), o: 100 + i * 2, h: 102 + i * 2, l: 99 + i * 2, c: 101 + i * 2, size_vs_atr: 1 }));
  const analysis = { get: async () => ({ candles: bars }) } as never;
  const failing = { generate: async () => { throw new Error("All configured providers failed: rate limited"); } } as never;
  await settleDueDecisions({ userId: L, analysis, provider: failing });
  const after1 = trading.listGradedDecisions(L).find((x) => x.id === d.id)!;
  if (after1.verdict === "missed_long" || after1.verdict === "missed_short" || after1.verdict === "bad_call") {
    assert.equal(after1.lessonPending, true, "owed, not lost");
    const working = {
      generate: async () => ({ text: "", toolCalls: [{ id: "1", name: "submit_lessons", arguments: { items: [{ id: d.id, lesson: "VOL_10 trended up all session -- a skip on 'no setup' missed a clean trend; check H1 trend before skipping.", neuron: "trend" }] } }] }),
    } as never;
    const r = await settleDueDecisions({ userId: L, analysis, provider: working });
    const after2 = trading.listGradedDecisions(L).find((x) => x.id === d.id)!;
    assert.ok(after2.lesson && !after2.lessonPending, `the retry wrote the lesson (${JSON.stringify(r)})`);
  } else {
    console.log(`   (graded ${after1.verdict} -- no lesson owed for this candle shape)`);
  }
  console.log("   ✓\n");

  console.log("=== step194: ALL ASSERTIONS PASSED ===");
} finally {
  process.chdir(tmpdir());
  rmSync(workDir, { recursive: true, force: true });
}
process.exit(0);
