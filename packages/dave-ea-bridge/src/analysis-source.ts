import type { AnalysisSource } from "@dave/trading";
import { requestAnalysis } from "./analysis-request.js";

/**
 * Item 5 real gap fixed (DAVEMA retirement): the real implementation of dave-trading's
 * `AnalysisSource` abstraction -- backed by the connected MT5 EA's own on-demand analysis
 * (requestAnalysis, same command-queue/report round trip every trade command already uses), not
 * the retired external DAVEMA HTTP API. This is what dave-agent-loop's full-registry.ts wires
 * into every trading tool that used to depend on `DavemaClient` directly.
 */
export function createEaAnalysisSource(userId: string): AnalysisSource {
  return {
    get: <T = unknown>(endpoint: string, symbol: string, timeframe = "M15") =>
      requestAnalysis(userId, endpoint, symbol, timeframe) as Promise<T>,
  };
}
