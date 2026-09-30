import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider, CompletionRequest, CompletionResult } from "@dave/brain";

/**
 * The trader (30 Sep): every alert must reach mode 2; "add other safe alert too"; after the last
 * pair start again from VOL_10, with a button to restart; and an "X-High" thinking level that
 * thinks 10-11 times or more.
 */

const workDir = mkdtempSync(join(tmpdir(), "dave-step195-"));
process.env.DAVE_DATA_ROOT = workDir;

const { publishActivity } = await import("../src/activity-bus.js");
const { selfAwareFeedBlock } = await import("../src/self-aware-feed.js");
const { safetyChecks, SPREAD_SPIKE_X } = await import("../src/safety-alerts.js");
const { getCursorPosition, advanceCursor, resetScanCursor } = await import("../src/autonomous-tick-state.js");
const { setAutonomousTradingEnabled } = await import("../src/autonomous-trading-state.js");
const { runSequentialThinking, EFFORT_PROFILES } = await import("../src/sequential-thinking.js");
const trading = await import("@dave/trading");

const ALL_ON = { spread_spike: true, margin_low: true, stop_too_tight: true, market_close: true };

try {
  console.log("[1] Every kind of background alert reaches the next scan's prompt\n");
  const U = "feed-user";
  const kinds = ["self_aware", "level_hit", "setup", "scalp", "drawdown", "safety", "nous_note", "trade_modified", "alert"];
  for (const k of kinds) publishActivity(U, "background", k, { text: `alert of kind ${k}` });
  const block = selfAwareFeedBlock(U)!;
  for (const k of kinds) assert.ok(block.includes(`alert of kind ${k}`), `${k} is in the scan prompt`);
  assert.match(block, /\[daily loss limit\]/);
  assert.match(block, /\[pullback scalp\]/);
  console.log("   ✓\n");

  console.log("[2] Spread spike: learns the normal spread, alerts once on a 3x jump\n");
  const S = "safety-user";
  const pos = (extra: Record<string, unknown>) => ({ ticket: "7", symbol: "VOL_10", type: "buy" as const, lots: 0.1, openPrice: 100, currentPrice: 101, digits: 2, ...extra });
  const t0 = Date.UTC(2026, 8, 30, 10, 0); // a Wednesday
  for (let i = 0; i < 12; i++) assert.deepEqual(safetyChecks(S, [pos({ spread: 0.1 })], t0 + i * 30_000, ALL_ON), []);
  let msgs = safetyChecks(S, [pos({ spread: 0.1 * SPREAD_SPIKE_X + 0.01 })], t0 + 400_000, ALL_ON);
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /SPREAD SPIKE on VOL_10/);
  assert.deepEqual(safetyChecks(S, [pos({ spread: 0.4 })], t0 + 430_000, ALL_ON), [], "not repeated within the cooldown");
  console.log("   ✓\n");

  console.log("[3] Margin level: warns under 200%, again under 120%, not every sweep\n");
  const M = "margin-user";
  const snapDir = join(workDir, "data", "ea-bridge", M);
  mkdirSync(snapDir, { recursive: true });
  const setMargin = (ml: number) => writeFileSync(join(snapDir, "account-snapshot.json"), JSON.stringify({ balance: 1000, equity: 900, marginLevel: ml, updatedAt: Date.now() }));
  setMargin(350);
  assert.deepEqual(safetyChecks(M, [pos({})], t0, ALL_ON), []);
  setMargin(180);
  assert.match(safetyChecks(M, [pos({})], t0, ALL_ON)[0], /MARGIN LOW/);
  assert.deepEqual(safetyChecks(M, [pos({})], t0 + 30_000, ALL_ON), []);
  setMargin(110);
  assert.match(safetyChecks(M, [pos({})], t0 + 60_000, ALL_ON)[0], /MARGIN CRITICAL/);
  console.log("   ✓\n");

  console.log("[4] A stop inside the spread is flagged once; the switch silences it\n");
  const T = "tight-user";
  msgs = safetyChecks(T, [pos({ sl: 100.95, spread: 0.1, stopsLevel: 0 })], t0, ALL_ON);
  assert.match(msgs[0], /STOP TOO TIGHT: VOL_10 #7/);
  assert.deepEqual(safetyChecks(T, [pos({ sl: 100.95, spread: 0.1 })], t0 + 30_000, ALL_ON), []);
  assert.deepEqual(safetyChecks("tight-off", [pos({ sl: 100.95, spread: 0.1 })], t0, { ...ALL_ON, stop_too_tight: false }), []);
  assert.ok(trading.ALERT_CATEGORIES.some((c: { id: string }) => c.id === "stop_too_tight"), "listed in the app's alert switches");
  console.log("   ✓\n");

  console.log("[5] Forex still open in the last hour before the weekend close\n");
  const fri = Date.UTC(2026, 9, 2, 21, 15); // Friday 21:15 UTC
  msgs = safetyChecks("fx-user", [{ ticket: "9", symbol: "EURUSD", type: "sell", lots: 0.1, openPrice: 1.1 }, pos({})], fri, ALL_ON);
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /MARKET CLOSES IN UNDER AN HOUR[\s\S]*EURUSD #9/);
  assert.ok(!msgs[0].includes("VOL_10"), "synthetics trade through the weekend");
  console.log("   ✓\n");

  console.log("[6] The scan starts from the first pair again when switched on, and from the button\n");
  const C = "cursor-user";
  for (let i = 0; i < 3; i++) advanceCursor(C, 8, 0);
  assert.equal(getCursorPosition(C).symbolCursor, 3);
  setAutonomousTradingEnabled(C, true);
  const req = trading.consumeScanRestart(C);
  assert.equal(req?.source, "scan switched on");
  assert.equal(trading.consumeScanRestart(C), undefined, "acted on once");
  resetScanCursor(C);
  assert.deepEqual(getCursorPosition(C), { symbolCursor: 0, scanningFallback: false });
  setAutonomousTradingEnabled(C, true);
  assert.equal(trading.consumeScanRestart(C), undefined, "already on: no restart");
  trading.requestScanRestart(C, "app button");
  assert.equal(trading.consumeScanRestart(C)?.source, "app button");
  for (let i = 0; i < 8; i++) advanceCursor(C, 8, 0);
  assert.equal(getCursorPosition(C).symbolCursor, 0, "after the last pair it is back at the first");
  console.log("   ✓\n");

  console.log("[7] X-High thinks at least 11 times, then the critic\n");
  let n = 0;
  let critiqued = false;
  const stages = ["bias", "trigger", "invalidation", "target", "counter", "memory", "scenario", "verdict"];
  const provider: Provider = {
    name: "mock",
    generate: async (r: CompletionRequest): Promise<CompletionResult> => {
      const tool = r.tools?.[0]?.name;
      if (tool === "submit_critique") {
        critiqued = true;
        return { text: "", provider: "claude", latencyMs: 1, toolCalls: [{ id: "c", name: tool, arguments: { weakestPoint: "stop is tight", holds: true } }] };
      }
      const stage = stages[Math.min(n, stages.length - 1)];
      n++;
      // A lazy model: wants to stop after every stage is covered.
      return { text: "", provider: "claude", latencyMs: 1, toolCalls: [{ id: `t${n}`, name: "submit_thought", arguments: { thought: `${stage} ${n}`, thoughtNumber: n, totalThoughts: 8, nextThoughtNeeded: n < 8, stage } }] };
    },
  };
  const r = await runSequentialThinking({ provider, systemPrompt: "s", contextLines: ["ctx"], effort: "xhigh" });
  const own = r.thoughts.filter((t) => !t.answersCritic);
  assert.ok(own.length >= 11, `thought ${own.length} times`);
  assert.ok(own.length <= EFFORT_PROFILES.xhigh.maxThoughts);
  assert.ok(critiqued, "the critic ran");
  assert.ok(trading.THINKING_EFFORTS.includes("xhigh"), "a setting the app can choose");
  console.log("   ✓\n");

  console.log("=== step195: ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
process.exit(0);
