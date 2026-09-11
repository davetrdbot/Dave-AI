import { randomBytes } from "node:crypto";
import { enqueueCommand, takeAnalysisResult } from "./ea-webhook.js";

/**
 * Item 5 (DAVEMA retirement): the on-demand replacement for the old direct-HTTP DAVEMA call.
 * Dave used to call `ctx.davema.data(endpoint, symbol, timeframe)` straight over HTTPS; DAVEMA
 * is retired, so this is the new real path -- enqueue an "analyze" command for the EA (same
 * command-queue/report-result round trip every trade command already uses, see ea-webhook.ts),
 * then poll for the EA's own real result by commandId. Critically: this does NOT change the
 * EA's existing heartbeat/push cadence at all -- it's a genuinely separate on-demand request,
 * not a new streaming channel, so a tool call Dave never makes costs nothing extra.
 */
export class AnalysisTimeoutError extends Error {
  constructor(endpoint: string, symbol: string, timeoutMs: number) {
    super(`No response from the EA for ${endpoint}(${symbol}) within ${timeoutMs}ms -- is the EA connected and polling?`);
    this.name = "AnalysisTimeoutError";
  }
}

export class AnalysisFailedError extends Error {
  constructor(endpoint: string, symbol: string, reason: string) {
    super(`EA reported an error computing ${endpoint}(${symbol}): ${reason}`);
    this.name = "AnalysisFailedError";
  }
}

export async function requestAnalysis(
  userId: string,
  endpoint: string,
  symbol: string,
  timeframe: string,
  opts: { timeoutMs?: number; pollIntervalMs?: number } = {}
): Promise<unknown> {
  // Real bug fixed (user: "increase the timeout... make sure they is nothing stopping the agent
  // to trade"). Same real round-trip as ea-trade-executor.ts -- an "analyze" command's result
  // also only ships on the EA's NEXT scheduled report after the one that picked it up, and the
  // EA's push interval now defaults to 2 minutes, not the old 6 seconds this 15s default was
  // calibrated for. A pre-trade get_all_analysis call timing out here would silently abort the
  // whole decision before trade_execute is ever reached.
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 300;
  const id = randomBytes(6).toString("hex");
  enqueueCommand(userId, { id, action: "analyze", endpoint, symbol, timeframe });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = takeAnalysisResult(userId, id);
    if (result) {
      if (result.status === "error") throw new AnalysisFailedError(endpoint, symbol, result.message ?? "unknown error");
      return result.data;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new AnalysisTimeoutError(endpoint, symbol, timeoutMs);
}
