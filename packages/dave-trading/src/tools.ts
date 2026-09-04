import type { DavemaClient } from "@dave/davema";
import type { TradeExecutor } from "./trade-executor.js";
import { findSetup } from "./find-setup.js";
import { tradeExecute, tradeModify, partialClose, fullClose, deletePendingOrder, deleteAllPendingOrders } from "./trade-execute.js";
import { validateOrder, type OrderRequest } from "./order-types.js";
import { enableBreakevenTrailing, disableBreakevenTrailing } from "./breakeven-trailing.js";

/**
 * Agentic tool exposure. Real gap this fills: everything in this
 * package (find_setup, trade_execute, etc.) previously existed only as
 * plain functions a Telegram command handler could call -- meaning Dave
 * could only "find a setup" if the user explicitly asked with /command.
 * Per explicit feedback: Dave shouldn't need to be told; it should be
 * able to reach for these itself as part of its own reasoning, the same
 * way any tool-calling agent picks a tool because the situation calls
 * for it, not because a human typed a specific command.
 *
 * This is the tool MANIFEST -- name, description, JSON-schema
 * parameters, and a real handler -- in the shape any tool-calling LLM
 * loop (the eventual DSH agent loop, or a direct Anthropic/DeepSeek
 * tool-use call) expects. Wiring this manifest into an actual running
 * agent loop is a later-step concern (the loop itself doesn't exist yet
 * -- Step 3's dave-core/agent-loop.ts is still a stub, and DSH hasn't
 * been booted as Dave's runtime yet, per the Step 3 architecture note).
 * What's real here is that the tools are genuinely callable, tested,
 * and shaped correctly for that wiring to be a connection, not a rewrite.
 */

export interface ToolContext {
  userId: string;
  davema: DavemaClient;
  executor: TradeExecutor;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

export const TRADING_TOOLS: ToolDefinition[] = [
  {
    name: "find_setup",
    description:
      "Scan the currently active pair group for a trade setup right now. Call this on your own initiative whenever you " +
      "want a fresh read on the market -- you do not need the user to ask first.",
    parameters: {
      type: "object",
      properties: { timeframe: { type: "string", description: "e.g. M15, H1, H4", default: "H1" } },
    },
    execute: async (args, ctx) => findSetup(ctx.userId, ctx.davema, (args.timeframe as string) ?? "H1"),
  },
  {
    name: "trade_execute",
    description: "Place a real order. Validates the order before sending -- never sends a malformed request.",
    parameters: {
      type: "object",
      required: ["symbol", "type", "lots"],
      properties: {
        symbol: { type: "string" },
        type: { type: "string", enum: ["buy", "sell", "buy_limit", "sell_limit", "buy_stop", "sell_stop"] },
        lots: { type: "number" },
        price: { type: "number", description: "required for pending order types" },
        sl: { type: "number" },
        tp: { type: "number" },
      },
    },
    execute: async (args, ctx) => tradeExecute(ctx.executor, args as unknown as OrderRequest),
  },
  {
    name: "trade_modify",
    description: "Change SL/TP on an open position. Pass null for either to remove it.",
    parameters: {
      type: "object",
      required: ["ticket"],
      properties: { ticket: { type: "string" }, sl: { type: ["number", "null"] }, tp: { type: ["number", "null"] } },
    },
    execute: async (args, ctx) => tradeModify(ctx.executor, args.ticket as string, { sl: args.sl as number | null, tp: args.tp as number | null }),
  },
  {
    name: "partial_close",
    description: "Close part of an open position, leaving the rest running.",
    parameters: { type: "object", required: ["ticket", "lots"], properties: { ticket: { type: "string" }, lots: { type: "number" } } },
    execute: async (args, ctx) => partialClose(ctx.executor, args.ticket as string, args.lots as number),
  },
  {
    name: "full_close",
    description: "Close an entire open position.",
    parameters: { type: "object", required: ["ticket"], properties: { ticket: { type: "string" } } },
    execute: async (args, ctx) => fullClose(ctx.executor, args.ticket as string),
  },
  {
    name: "delete_pending_order",
    description: "Delete one specific pending order.",
    parameters: { type: "object", required: ["ticket"], properties: { ticket: { type: "string" } } },
    execute: async (args, ctx) => deletePendingOrder(ctx.executor, args.ticket as string),
  },
  {
    name: "delete_all_pending_orders",
    description: "Delete every pending order at once.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => deleteAllPendingOrders(ctx.executor),
  },
  {
    name: "validate_order",
    description: "Check an order for errors before placing it, without actually sending it.",
    parameters: {
      type: "object",
      required: ["symbol", "type", "lots"],
      properties: { symbol: { type: "string" }, type: { type: "string" }, lots: { type: "number" }, price: { type: "number" } },
    },
    execute: async (args) => validateOrder(args as unknown as OrderRequest),
  },
];

/**
 * Breakeven/trailing is deliberately NOT in the tool list above as
 * something exposed for every trade -- it's a per-position judgment
 * call, opted into explicitly. These two stay as plain functions Dave's
 * reasoning invokes directly when it decides a specific position calls
 * for it, re-exported here so the "this is a real, deliberate capability,
 * not an accidental omission" intent is visible in one place.
 */
export { enableBreakevenTrailing, disableBreakevenTrailing };
