import type { AnalysisSource } from "./analysis-source.js";
import type { TradeExecutor } from "./trade-executor.js";
import { findSetup, huntForSetup } from "./find-setup.js";
import { tradeExecute, tradeModify, partialClose, fullClose, deletePendingOrder, deleteAllPendingOrders } from "./trade-execute.js";
import { validateOrder, resolveEntryPrice, isPendingOrderType, type OrderRequest } from "./order-types.js";
import { enableBreakevenTrailing, disableBreakevenTrailing } from "./breakeven-trailing.js";
import { evaluateConfidenceGate } from "./confidence-gate.js";
import { getRiskSettings } from "./risk-settings.js";
import { getSettingsLog } from "./settings-log.js";

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

/**
 * Item 3 real bug fixed: the real, enforced consequence of SL/TP mode = "auto". Thrown back to
 * the MODEL as a tool error (never surfaced to the user as a question) so it computes a real
 * value from its own analysis (ATR/structure/support-resistance) and retries -- "auto" never
 * silently leaves an order unprotected, and never becomes the user's problem to answer.
 */
export class AutoModeRequiresComputedValueError extends Error {
  constructor(field: "sl" | "tp", symbol: string) {
    super(
      `${field.toUpperCase()} mode is set to "auto" for this user -- you must compute a real ${field} value yourself ` +
        `(from ATR, market structure, or support/resistance on ${symbol}) and pass it explicitly to trade_execute. ` +
        `Never ask the user for this value while auto mode is active, and never leave the order unprotected -- retry ` +
        `the call with a real, calculated ${field}.`
    );
    this.name = "AutoModeRequiresComputedValueError";
  }
}

export interface ToolContext {
  userId: string;
  analysis: AnalysisSource;
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
    execute: async (args, ctx) => findSetup(ctx.userId, ctx.analysis, (args.timeframe as string) ?? "H1"),
  },
  {
    name: "hunt_for_setup",
    description:
      "Aggressively hunt for a real trade setup RIGHT NOW -- this is what 'go hunt for a setup' means. Scans your active " +
      "pair group; if a single-pair focus is set and it has nothing good, this automatically broadens to the rest of " +
      "the group instead of just giving up (huntModeActivated:true in the result tells you when that happened). Pass " +
      "excludeSymbols to re-hunt after a candidate was declined -- never re-propose the same symbol the user just said no to.",
    parameters: {
      type: "object",
      properties: {
        timeframe: { type: "string", description: "e.g. M15, H1, H4", default: "H1" },
        excludeSymbols: { type: "array", items: { type: "string" }, description: "symbols to skip -- e.g. a candidate just declined" },
      },
    },
    execute: async (args, ctx) => huntForSetup(ctx.userId, ctx.analysis, (args.timeframe as string) ?? "H1", { excludeSymbols: args.excludeSymbols as string[] | undefined }),
  },
  {
    name: "trade_execute",
    description:
      "Place a real order. For buy_limit/sell_limit/buy_stop/sell_stop, price is optional: if omitted, a real current " +
      "market quote is pulled from the connected MT5 EA and a sensible entry is calculated a few pips off it. If the " +
      "EA is unreachable, this returns needsUserInput=true with a question to ask the user instead of failing silently or " +
      "rejecting the order -- never guess a strategy-significant entry price out of thin air. Pass your own real " +
      "confidence (0-100) for this specific setup: below the user's confidence threshold (see " +
      "get_confidence_settings), the order is queued for the user's explicit approval instead of firing immediately, " +
      "unless they've turned on auto-approval for that case -- this returns needsApproval=true with a pendingId " +
      "rather than a ticket when that happens.",
    parameters: {
      type: "object",
      required: ["symbol", "type", "lots"],
      properties: {
        symbol: { type: "string" },
        type: { type: "string", enum: ["buy", "sell", "buy_limit", "sell_limit", "buy_stop", "sell_stop"] },
        lots: { type: "number" },
        price: { type: "number", description: "explicit entry price for pending order types -- auto-calculated from a live quote if omitted" },
        sl: { type: "number" },
        tp: { type: "number" },
        confidence: { type: "number", description: "your own real assessed confidence (0-100) for this specific trade" },
        reason: { type: "string", description: "brief reason behind the confidence score, shown to the user if approval is needed" },
      },
    },
    execute: async (args, ctx) => {
      const { confidence, reason, ...rest } = args;
      const order = rest as unknown as OrderRequest;
      if (isPendingOrderType(order.type) && order.price === undefined) {
        let referencePrice: number | undefined;
        try {
          const quote = await ctx.analysis.get<{ bid?: number; ask?: number; close?: number }>("price", order.symbol);
          referencePrice = quote?.ask ?? quote?.bid ?? quote?.close;
        } catch {
          // EA unreachable -- fall through, resolveEntryPrice below will ask instead of failing silently.
        }
        const resolution = resolveEntryPrice(order, referencePrice !== undefined ? { referencePrice, offsetPips: 10 } : {});
        if (!resolution.resolved) {
          return {
            needsUserInput: true,
            question: `What entry price should I use for the ${order.type} on ${order.symbol}? (${resolution.reason})`,
          };
        }
        order.price = resolution.price;
      }
      // Real gap fixed (user: "confirm if the bot took for trade even to set tp and set sl
      // too") -- the user's real SL/TP mode+value in /settings (Risk / Trading) was never
      // actually consulted here: a trade only ever got SL/TP if the model happened to pass
      // sl/tp args itself, silently ignoring "on" mode entirely. When the model omits sl/tp,
      // "on" mode (a real pip distance the user set) is now applied for real, off a real live
      // quote -- same DAVEMA price lookup + offset mechanism pending-order entry resolution
      // already uses above, just reused for SL/TP instead of left completely unused. Never
      // invents a value for "auto" mode (that's a strategy judgment call, not this module's to
      // make) or when no live quote is reachable -- it stays honestly unset, visible to the user
      // in the real placement confirmation ("SL: not set") rather than silently guessed.
      if (order.sl === undefined || order.tp === undefined) {
        const risk = getRiskSettings(ctx.userId);
        // Item 3 real bug fixed (user: "when SL/TP mode is set to Auto, Dave must calculate and
        // set real SL/TP values itself during analysis, every time, no exceptions -- it should
        // NEVER ask the user for SL/TP values when Auto is active"): this block previously only
        // ever checked slMode/tpMode === "on" -- "auto" fell through both branches below and
        // silently left the order unprotected, which is exactly what let the model ask the user
        // instead. "Auto" means Dave computes a real value from its own analysis (ATR/structure/
        // S-R) -- not something this module should invent a formula for -- so the fix is a hard
        // gate: reject the call back to the MODEL (a tool error, never a user-facing question)
        // when auto mode is active and sl/tp is still missing, forcing it to compute and retry.
        if (order.sl === undefined && risk.slMode === "auto") {
          throw new AutoModeRequiresComputedValueError("sl", order.symbol);
        }
        if (order.tp === undefined && risk.tpMode === "auto") {
          throw new AutoModeRequiresComputedValueError("tp", order.symbol);
        }
        let referencePrice = order.price;
        if (referencePrice === undefined) {
          try {
            const quote = await ctx.analysis.get<{ bid?: number; ask?: number; close?: number }>("price", order.symbol);
            referencePrice = quote?.ask ?? quote?.bid ?? quote?.close;
          } catch {
            // No live quote -- sl/tp stay honestly unset below, never guessed.
          }
        }
        if (referencePrice !== undefined) {
          const direction = order.type === "buy" || order.type === "buy_limit" || order.type === "buy_stop" ? 1 : -1;
          const pip = 0.0001;
          if (order.sl === undefined && risk.slMode === "on" && risk.slValue !== undefined) {
            order.sl = referencePrice - direction * risk.slValue * pip;
          }
          if (order.tp === undefined && risk.tpMode === "on" && risk.tpValue !== undefined) {
            order.tp = referencePrice + direction * risk.tpValue * pip;
          }
        }
      }
      if (typeof confidence === "number") {
        const gate = evaluateConfidenceGate(ctx.userId, order, confidence, reason as string | undefined);
        if (gate.needsApproval) {
          return { needsApproval: true, pendingId: gate.pendingId, confidence, threshold: gate.threshold };
        }
      }
      const result = await tradeExecute(ctx.executor, order);
      return typeof confidence === "number" ? { ...result, confidence } : result;
    },
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
    name: "modify_sl_tp",
    description: "Set a new SL and/or TP on an open position -- explicit alias of trade_modify for when the intent is specifically to SET new levels, not remove them.",
    parameters: {
      type: "object",
      required: ["ticket"],
      properties: { ticket: { type: "string" }, sl: { type: "number" }, tp: { type: "number" } },
    },
    execute: async (args, ctx) => tradeModify(ctx.executor, args.ticket as string, { sl: args.sl as number | undefined, tp: args.tp as number | undefined }),
  },
  {
    name: "remove_sl_tp",
    description: "Remove SL only, TP only, or both from an open position -- pass which side(s) to remove.",
    parameters: {
      type: "object",
      required: ["ticket"],
      properties: {
        ticket: { type: "string" },
        removeSl: { type: "boolean", default: false },
        removeTp: { type: "boolean", default: false },
      },
    },
    execute: async (args, ctx) =>
      tradeModify(ctx.executor, args.ticket as string, {
        sl: args.removeSl ? null : undefined,
        tp: args.removeTp ? null : undefined,
      }),
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
  {
    name: "get_settings_log",
    description:
      "Get the real, durable log of every settings change on this account (SL/TP/lot mode, active pair group, confidence threshold, auto-approve, trading mode) -- field, old value, new " +
      "value, when. The user changes settings directly through /settings or the admin panel, which never shows up in your own conversation history -- check this log instead of treating a " +
      "value you don't remember setting as suspicious. Most recent first.",
    parameters: { type: "object", properties: { limit: { type: "number", description: "how many entries, default 50" } } },
    execute: async (args, ctx) => getSettingsLog(ctx.userId, (args.limit as number | undefined) ?? 50),
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
