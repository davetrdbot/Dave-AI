import { TRADING_TOOLS, type ToolDefinition } from "@dave/trading";
import { routeForWorker, type ModelConfig } from "@dave/brain";
import type { Worker } from "./worker-factory.js";

/**
 * Step 12.5: full feature parity except opening real trades, unless
 * designated a trading worker. The tools that actually place/modify/
 * close real trades are excluded for a non-trading worker; everything
 * else (find_setup, validate_order -- read-only/analysis tools) stays
 * available, matching "full parity except real trades," not "no trading
 * tools at all."
 */
const TRADE_PLACING_TOOLS = new Set(["trade_execute", "trade_modify", "partial_close", "full_close", "delete_pending_order", "delete_all_pending_orders"]);

export function toolsForWorker(worker: Worker): ToolDefinition[] {
  if (worker.role === "trading") return TRADING_TOOLS;
  return TRADING_TOOLS.filter((t) => !TRADE_PLACING_TOOLS.has(t.name));
}

/** Step 5.4 already routes workers away from AirLLM -- this just makes that decision reachable per-worker. */
export function modelConfigForWorker(_worker: Worker, preferred: "deepseek" | "claude" = "deepseek"): ModelConfig {
  return routeForWorker(preferred);
}
