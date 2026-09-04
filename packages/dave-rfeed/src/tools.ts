import { tradeExecute, tradeModify, partialClose, fullClose, deletePendingOrder, deleteAllPendingOrders, type OrderRequest } from "@dave/trading";
import type { DaveDatabase } from "@dave/db";
import type { RFeedTradeExecutor } from "./rfeed-trade-executor.js";
import type { HistoryRequestManager } from "./history.js";
import { recordTradeNote } from "./trade-notes.js";

/**
 * Real, agent-callable R_Feed tools -- same `ToolDefinition` shape as
 * every other tool manifest in this repo (Step 10's TRADING_TOOLS),
 * clearly scoped to the demo account: the trade-execution tools reuse
 * Step 10's own `tradeExecute`/`tradeModify`/etc functions UNCHANGED,
 * just pointed at `RFeedTradeExecutor` instead of the real one --
 * proof by construction that this is "the same trade-execution engine
 * pattern," not a rewrite.
 */

export interface RFeedToolContext {
  userId: string;
  db: DaveDatabase;
  executor: RFeedTradeExecutor;
  historyManager: HistoryRequestManager;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: RFeedToolContext) => Promise<unknown>;
}

export const RFEED_TOOLS: ToolDefinition[] = [
  {
    name: "request_history",
    description: "Download real historical candles for a symbol/timeframe/date range from the shared R_Feed demo account -- real MT5 CopyRates data, for backtesting an idea before ever risking real money.",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        timeframe: { type: "string", description: "e.g. M15, H1, H4, D1" },
        startTime: { type: "string", description: "ISO date" },
        endTime: { type: "string", description: "ISO date" },
      },
      required: ["symbol", "timeframe", "startTime", "endTime"],
    },
    execute: async (args, ctx) => {
      const candles = await ctx.historyManager.requestHistory(args.symbol as string, args.timeframe as string, new Date(args.startTime as string), new Date(args.endTime as string));
      return { symbol: args.symbol, candleCount: candles.length, candles };
    },
  },
  {
    name: "place_paper_trade",
    description: "Place a REAL order on the shared R_Feed demo account -- real fills, real SL/TP, zero real money at risk. Refuses custom/synthetic symbols. Never touches the user's real account.",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        type: { type: "string", enum: ["buy", "sell", "buy_limit", "sell_limit", "buy_stop", "sell_stop"] },
        lots: { type: "number" },
        price: { type: "number" },
        sl: { type: "number" },
        tp: { type: "number" },
        note: { type: "string", description: "Full strategy/reasoning note -- stored in the DB, linked by the real ticket, never crammed into MT5's short comment field." },
      },
      required: ["symbol", "type", "lots"],
    },
    execute: async (args, ctx) => {
      const order = { symbol: args.symbol, type: args.type, lots: args.lots, price: args.price, sl: args.sl, tp: args.tp } as OrderRequest;
      const result = await tradeExecute(ctx.executor, order);
      if (args.note) recordTradeNote(ctx.db, ctx.userId, result.ticket, args.note as string);
      return result;
    },
  },
  {
    name: "modify_paper_trade",
    description: "Modify SL/TP (or explicitly remove one/both) on an open R_Feed paper position.",
    parameters: {
      type: "object",
      properties: { ticket: { type: "string" }, sl: { type: ["number", "null"] }, tp: { type: ["number", "null"] } },
      required: ["ticket"],
    },
    execute: async (args, ctx) => {
      await tradeModify(ctx.executor, args.ticket as string, { sl: args.sl as number | null | undefined, tp: args.tp as number | null | undefined });
      return { ok: true };
    },
  },
  {
    name: "partial_close_paper_trade",
    description: "Close only part of an open R_Feed paper position, leaving the rest open.",
    parameters: { type: "object", properties: { ticket: { type: "string" }, lots: { type: "number" } }, required: ["ticket", "lots"] },
    execute: async (args, ctx) => partialClose(ctx.executor, args.ticket as string, args.lots as number),
  },
  {
    name: "close_paper_trade",
    description: "Fully close an open R_Feed paper position.",
    parameters: { type: "object", properties: { ticket: { type: "string" } }, required: ["ticket"] },
    execute: async (args, ctx) => fullClose(ctx.executor, args.ticket as string),
  },
  {
    name: "delete_paper_pending_order",
    description: "Delete one specific pending R_Feed paper order.",
    parameters: { type: "object", properties: { ticket: { type: "string" } }, required: ["ticket"] },
    execute: async (args, ctx) => {
      await deletePendingOrder(ctx.executor, args.ticket as string);
      return { ok: true };
    },
  },
  {
    name: "delete_all_paper_pending_orders",
    description: "Delete every pending R_Feed paper order.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => deleteAllPendingOrders(ctx.executor),
  },
];
