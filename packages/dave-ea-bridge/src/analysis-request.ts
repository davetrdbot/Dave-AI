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

/** One finished request to the EA, for the app's Live tab ("when the bot is demanding for any
 *  candles and others I should see it"). */
export interface EaRequestEvent {
  userId: string;
  endpoint: string;
  symbol: string;
  timeframe: string;
  ok: boolean;
  ms: number;
  error?: string;
}

const requestListeners = new Set<(e: EaRequestEvent) => void>();

/** Watches every analysis request made to the EA. Returns an unsubscribe function. */
export function onEaRequest(listener: (e: EaRequestEvent) => void): () => void {
  requestListeners.add(listener);
  return () => requestListeners.delete(listener);
}

function emitRequest(e: EaRequestEvent): void {
  for (const l of requestListeners) {
    try {
      l(e);
    } catch {
      /* a broken listener never breaks a request */
    }
  }
}

export async function requestAnalysis(
  userId: string,
  endpoint: string,
  symbol: string,
  timeframe: string,
  opts: { timeoutMs?: number; pollIntervalMs?: number; params?: Record<string, string | number | boolean> } = {}
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
  // Extra flat settings (candle count, position-size inputs, history days) ride on the same command;
  // they never overwrite the command's own fields.
  enqueueCommand(userId, { ...(opts.params ?? {}), id, action: "analyze", endpoint, symbol, timeframe });

  const started = Date.now();
  const deadline = started + timeoutMs;
  const report = (ok: boolean, error?: string) => emitRequest({ userId, endpoint, symbol, timeframe, ok, ms: Date.now() - started, error });
  while (Date.now() < deadline) {
    const result = takeAnalysisResult(userId, id);
    if (result) {
      if (result.status === "error") {
        report(false, result.message ?? "unknown error");
        throw new AnalysisFailedError(endpoint, symbol, result.message ?? "unknown error");
      }
      report(true);
      return result.data;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  report(false, "timed out");
  throw new AnalysisTimeoutError(endpoint, symbol, timeoutMs);
}
