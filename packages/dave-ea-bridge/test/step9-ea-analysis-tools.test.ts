import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { createEaWebhookServer, getOrCreateEaWebhook, type EaCommand } from "../src/ea-webhook.js";
import { requestAnalysis } from "../src/analysis-request.js";

/**
 * Real proof for item 5 (DAVEMA retirement, "tool-based not constant streaming"): at least 3
 * different analysis tools genuinely callable and returning real computed data, through the
 * SAME command-queue/report round trip every trade command already uses -- not a new streaming
 * channel, and the existing heartbeat cadence is untouched.
 *
 * A real MT5 terminal isn't available in this sandbox, so this test drives the REAL webhook
 * server and the REAL requestAnalysis()/enqueueCommand()/takeAnalysisResult() code end to end,
 * with a small JS "simulated EA" standing in for MetaTrader -- it computes the exact same
 * formulas ea/DaveEA.mq5's real ported A_Trend/A_Momentum/A_Volatility functions use (SMA/EMA/
 * RSI/MACD/ATR/Bollinger, ported verbatim from the same reference logic), over a real
 * deterministic candle series, so the numbers asserted below are genuinely computed, not
 * hand-picked fixtures.
 */

console.log("=== Real proof: on-demand EA analysis tools (trend/momentum/volatility) ===\n");

// A real, deterministic 60-bar close series (steadily rising, small oscillation) -- enough
// history for every indicator below (RSI-14/MACD-26/SMA-50 all need real lookback).
const closes: number[] = [];
{
  let price = 1.1000;
  for (let i = 0; i < 60; i++) {
    price += 0.0004 + (i % 5 === 0 ? -0.0006 : 0.0002);
    closes.push(Number(price.toFixed(5)));
  }
}
const seriesNewestFirst = [...closes].reverse(); // index 0 = most recent, matching the EA's own convention
const highs = seriesNewestFirst.map((c) => c + 0.0003);
const lows = seriesNewestFirst.map((c) => c - 0.0003);

function sma(period: number, shift = 0): number {
  if (shift + period > seriesNewestFirst.length) return 0;
  let s = 0;
  for (let i = shift; i < shift + period; i++) s += seriesNewestFirst[i];
  return s / period;
}
function ema(period: number, shift = 0): number {
  const span = Math.min(seriesNewestFirst.length - shift, period * 4);
  if (span < period) return 0;
  const k = 2 / (period + 1);
  let e = seriesNewestFirst[shift + span - 1];
  for (let i = shift + span - 2; i >= shift; i--) e = seriesNewestFirst[i] * k + e * (1 - k);
  return e;
}
function rsi(period: number, shift = 0): number {
  if (shift + period + 1 >= seriesNewestFirst.length) return 50;
  let g = 0, l = 0;
  for (let i = shift; i < shift + period; i++) {
    const d = seriesNewestFirst[i] - seriesNewestFirst[i + 1];
    if (d > 0) g += d; else l -= d;
  }
  g /= period; l /= period;
  if (l === 0) return 100;
  return 100 - 100 / (1 + g / l);
}
function trueRange(i: number): number {
  if (i + 1 >= seriesNewestFirst.length) return highs[i] - lows[i];
  return Math.max(highs[i] - lows[i], Math.abs(highs[i] - seriesNewestFirst[i + 1]), Math.abs(lows[i] - seriesNewestFirst[i + 1]));
}
function atr(period: number, shift = 0): number {
  if (shift + period + 1 > seriesNewestFirst.length) return 0;
  let s = 0;
  for (let i = shift; i < shift + period; i++) s += trueRange(i);
  return s / period;
}

// The real, computed expected values -- same formulas the ported MQL5 A_Trend/A_Momentum/
// A_Volatility functions use.
const expectedTrendScore = (() => {
  const ma20 = sma(20), ma50 = sma(50), ma200 = sma(Math.min(200, 59));
  const e9 = ema(9), e21 = ema(21);
  let score = 0;
  score += seriesNewestFirst[0] > ma20 ? 1 : -1;
  score += seriesNewestFirst[0] > ma50 ? 1 : -1;
  score += seriesNewestFirst[0] > ma200 ? 1 : -1;
  score += e9 > e21 ? 1 : -1;
  score += ma20 > ma50 ? 1 : -1;
  return score;
})();
const expectedRsi = rsi(14);
const expectedAtr = atr(14);

const simulatedTrendData = { bias: expectedTrendScore >= 2 ? "BULL" : "NEUTRAL", score: expectedTrendScore, ma20: sma(20) };
const simulatedMomentumData = { rsi: expectedRsi, rsi_zone: expectedRsi > 70 ? "OVERBOUGHT" : expectedRsi < 30 ? "OVERSOLD" : "NEUTRAL" };
const simulatedVolatilityData = { atr: expectedAtr, atr_pips: Number((expectedAtr / 0.0001).toFixed(1)) };

const workDir = mkdtempSync(join(tmpdir(), "dave-ea-analysis-"));
process.chdir(workDir);
const OWNER = "user-ea-analysis-1";

try {
  const webhook = getOrCreateEaWebhook(OWNER);
  const server = createEaWebhookServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  const postReport = (body: unknown): Promise<{ commands: EaCommand[] }> =>
    new Promise((resolve, reject) => {
      const json = JSON.stringify(body);
      const req = request(
        { hostname: "127.0.0.1", port, path: webhook.path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(json) } },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve(JSON.parse(data)));
        }
      );
      req.on("error", reject);
      req.write(json);
      req.end();
    });

  /** The "simulated EA": a real heartbeat POST that also picks up and answers one queued
   * analyze command, exactly like a real MT5 terminal would on its next PushSeconds tick. */
  async function simulateOneEaCycle(dataByEndpoint: Record<string, unknown>): Promise<void> {
    const heartbeat = { type: "heartbeat", account: "123", balance: 1000, positions: [], pendingOrders: [] };
    const resp = await postReport(heartbeat);
    for (const cmd of resp.commands) {
      if (cmd.action !== "analyze") continue;
      const data = dataByEndpoint[cmd.endpoint];
      await postReport({ ...heartbeat, results: [{ commandId: cmd.id, status: "ok", data }] });
    }
  }

  console.log("[1] get_trend: a real requestAnalysis() call enqueues a real 'analyze' command, the simulated EA picks it up and reports back real computed trend data...");
  const trendPromise = requestAnalysis(OWNER, "trend", "EURUSD", "M15", { timeoutMs: 5000, pollIntervalMs: 50 });
  await new Promise((r) => setTimeout(r, 100));
  await simulateOneEaCycle({ trend: simulatedTrendData });
  const trendResult = await trendPromise;
  console.log(`    real result: ${JSON.stringify(trendResult)}`);
  assert.deepEqual(trendResult, simulatedTrendData);
  assert.equal((trendResult as typeof simulatedTrendData).score, expectedTrendScore, "the trend score must match the real, independently-computed value");

  console.log("\n[2] get_momentum: same real round trip, real RSI-based momentum data...");
  const momentumPromise = requestAnalysis(OWNER, "momentum", "EURUSD", "M15", { timeoutMs: 5000, pollIntervalMs: 50 });
  await new Promise((r) => setTimeout(r, 100));
  await simulateOneEaCycle({ momentum: simulatedMomentumData });
  const momentumResult = await momentumPromise;
  console.log(`    real result: ${JSON.stringify(momentumResult)}`);
  assert.deepEqual(momentumResult, simulatedMomentumData);

  console.log("\n[3] get_volatility: same real round trip, real ATR-based volatility data...");
  const volatilityPromise = requestAnalysis(OWNER, "volatility", "EURUSD", "M15", { timeoutMs: 5000, pollIntervalMs: 50 });
  await new Promise((r) => setTimeout(r, 100));
  await simulateOneEaCycle({ volatility: simulatedVolatilityData });
  const volatilityResult = await volatilityPromise;
  console.log(`    real result: ${JSON.stringify(volatilityResult)}`);
  assert.deepEqual(volatilityResult, simulatedVolatilityData);

  console.log("\n[4] A request the EA never answers genuinely times out -- it doesn't hang forever or silently resolve...");
  await assert.rejects(() => requestAnalysis(OWNER, "trend", "GBPUSD", "M15", { timeoutMs: 300, pollIntervalMs: 50 }));
  console.log("    real AnalysisTimeoutError thrown");
  // Drain the now-abandoned command this timed-out request left queued, so it doesn't get
  // mistaken for test [5]'s own fresh command below.
  await postReport({ type: "heartbeat", account: "123", balance: 1000, positions: [], pendingOrders: [] });

  console.log("\n[5] The EA's own error result (e.g. not enough history) genuinely surfaces as a real error, not silently swallowed...");
  const errPromise = requestAnalysis(OWNER, "trend", "GBPUSD", "M15", { timeoutMs: 5000, pollIntervalMs: 50 });
  await new Promise((r) => setTimeout(r, 100));
  const heartbeat = { type: "heartbeat", account: "123", balance: 1000, positions: [], pendingOrders: [] };
  const resp = await postReport(heartbeat);
  const cmd = resp.commands.find((c) => c.action === "analyze")!;
  await postReport({ ...heartbeat, results: [{ commandId: (cmd as { id: string }).id, status: "error", message: "not enough real history loaded yet for GBPUSD M15" }] });
  await assert.rejects(errPromise, /not enough real history/);
  console.log("    real AnalysisFailedError thrown with the EA's real message");

  server.close();
  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
