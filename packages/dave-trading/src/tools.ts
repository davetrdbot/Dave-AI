import type { AnalysisSource } from "./analysis-source.js";
import type { TradeExecutor } from "./trade-executor.js";
import { findSetup, huntForSetup } from "./find-setup.js";
import { tradeExecute, tradeModify, partialClose, fullClose, deletePendingOrder, deleteAllPendingOrders } from "./trade-execute.js";
import { validateOrder, resolveEntryPrice, isPendingOrderType, type OrderRequest } from "./order-types.js";
import { enableBreakevenTrailing, disableBreakevenTrailing } from "./breakeven-trailing.js";
import { evaluateConfidenceGate } from "./confidence-gate.js";
import { getRiskSettings } from "./risk-settings.js";
import { getSettingsLog } from "./settings-log.js";
import { derivePipSize } from "./pip-size.js";
import { assessRiskRewardForUser, getMinRiskReward, setMinRiskReward } from "./risk-reward-guard.js";
import { createWatch, listActiveWatches, cancelWatch, type WatchKind } from "./background-watch.js";
import { recordExpectation, findSimilarSetups, predictionAccuracySummary } from "./trade-prediction-store.js";

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

/**
 * Real money-safety bug fixed: trade_execute's confidence approval gate was bypassable simply by
 * omitting `confidence`, which was not a required parameter. Thrown back to the MODEL as a tool
 * error (never surfaced to the user as a question), same pattern as
 * AutoModeRequiresComputedValueError above, so it retries with a real number rather than a live
 * order going out completely ungated.
 */
export class ConfidenceRequiredError extends Error {
  constructor(symbol: string) {
    super(
      `trade_execute on ${symbol} requires your own real assessed confidence (0-100) for this specific setup. ` +
        `It was missing or not a valid number, so the order was NOT placed. The user's confidence threshold is a real ` +
        `safety control -- an order can never skip it by leaving confidence out. Retry with a genuine confidence score.`
    );
    this.name = "ConfidenceRequiredError";
  }
}

/**
 * Real bug fixed (the trader's own live chart): a placed order whose STOP was wider than its
 * TARGET -- risking 3,941 points to gain 3,759. Refused back to the model, same pattern as the
 * other typed tool errors here, so it re-computes its levels rather than sending a structurally
 * losing order to the broker.
 */
export class BadRiskStructureError extends Error {
  constructor(symbol: string, reason: string) {
    super(
      `trade_execute on ${symbol} was NOT placed: ${reason}. Recompute your stop and target so the trade ` +
        `stands to gain at least as much as it risks, with both levels on the correct side of the entry, then retry.`
    );
    this.name = "BadRiskStructureError";
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
      required: ["symbol", "type", "lots", "confidence"],
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
      // Hoisted so the risk-structure check further down can still see a real entry price even
      // when the SL/TP auto-fill block below did not need to run.
      let referencePriceForRisk: number | undefined = order.price;
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
        // Real bug fixed (bug-hunt pass): the quote was fetched, its price used, and the rest of
        // it thrown away -- including the `spread_pips` needed to know what a pip is worth on
        // THIS symbol. Kept now, for the pip derivation below.
        let quote: { bid?: number; ask?: number; close?: number; spread_pips?: number } | undefined;
        try {
          quote = await ctx.analysis.get<{ bid?: number; ask?: number; close?: number; spread_pips?: number }>("price", order.symbol);
        } catch {
          // No live quote -- sl/tp stay honestly unset below, never guessed.
        }
        if (referencePrice === undefined) referencePrice = quote?.ask ?? quote?.bid ?? quote?.close;
        referencePriceForRisk = referencePrice;
        if (referencePrice !== undefined) {
          const direction = order.type === "buy" || order.type === "buy_limit" || order.type === "buy_stop" ? 1 : -1;
          // Real bug fixed (bug-hunt pass) -- the SECOND copy of the hardcoded-pip bug. The same
          // `const pip = 0.0001` was fixed in autonomous-tick.ts for the autonomous path, and this
          // manual trade_execute path had its own identical copy that the first fix missed. Only
          // correct for 4-digit forex; on this trader's synthetic indices (real live prices in the
          // hundreds of thousands) a fixed-pip SL/TP resolved to a fraction of a point from entry
          // -- an instant stop-out or a broker rejection. Derived per symbol from the EA's own
          // numbers; left honestly unset when it cannot be established, exactly as this block
          // already does for a missing quote, rather than guessed.
          const pip = derivePipSize(quote);
          if (pip !== undefined) {
            if (order.sl === undefined && risk.slMode === "on" && risk.slValue !== undefined) {
              order.sl = referencePrice - direction * risk.slValue * pip;
            }
            if (order.tp === undefined && risk.tpMode === "on" && risk.tpValue !== undefined) {
              order.tp = referencePrice + direction * risk.tpValue * pip;
            }
          }
        }
      }
      // Real bug fixed (bug-hunt pass, money-safety): this used to be
      // `if (typeof confidence === "number")`, and `confidence` was NOT in this tool's required
      // list -- so omitting one optional field skipped the user's approval gate entirely and
      // fired a live order immediately, whatever threshold they had set.
      //
      // Note the first attempt at this fix was wrong and the existing step14 test caught it:
      // defaulting a missing confidence to 0 does NOT close the hole, because
      // evaluateConfidenceGate short-circuits on `settings.autoApproveBelowThreshold`, which
      // DEFAULTS TO TRUE -- so 0 would sail straight through and fire anyway. This is the same
      // remedy autonomous-tick.ts already chose for the identical hole in its own decision schema:
      // make confidence genuinely required, AND hard-refuse a missing/invalid value here as
      // defense in depth, since a model can always return something malformed regardless of what
      // the schema says. Refused back to the MODEL as a tool error (never surfaced to the user as
      // a question), exactly like AutoModeRequiresComputedValueError above, so it retries with a
      // real number instead of a live order going out ungated.
      // Same risk-structure guard the autonomous path enforces -- see risk-reward-guard.ts. A
      // stop wider than its target, or either level on the wrong side of entry, is refused back
      // to the MODEL as a tool error so it re-computes, rather than a structurally losing order
      // going to the broker.
      {
        const entry = order.price ?? referencePriceForRisk;
        if (entry !== undefined) {
          const rr = assessRiskRewardForUser(ctx.userId, order, entry);
          if (!rr.ok) throw new BadRiskStructureError(order.symbol, rr.reason ?? "risk structure is invalid");
        }
      }
      if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
        throw new ConfidenceRequiredError(order.symbol);
      }
      const gate = evaluateConfidenceGate(ctx.userId, order, confidence, reason as string | undefined);
      if (gate.needsApproval) {
        return { needsApproval: true, pendingId: gate.pendingId, confidence, threshold: gate.threshold };
      }
      const result = await tradeExecute(ctx.executor, order);
      return typeof confidence === "number" ? { ...result, confidence } : result;
    },
  },
  {
    name: "mark_level",
    description:
      "Start a real BACKGROUND check that runs on its own and alerts you when a price level is hit -- use this to mark a key level, " +
      "or to watch for price reaching a target or breaking a direction, instead of re-analysing the same symbol over and over. " +
      "It keeps running after this turn ends. `reason` is REQUIRED and is handed straight back to you when it fires, so write the " +
      "actual thesis (what the level is and why it matters) -- a level that triggers hours from now is useless without it. " +
      "Use check_marked_levels to see what's still pending and cancel_marked_level to stop one.",
    parameters: {
      type: "object",
      required: ["symbol", "kind", "level", "reason"],
      properties: {
        symbol: { type: "string" },
        kind: { type: "string", enum: ["price_at_or_above", "price_at_or_below"], description: "whether you're waiting for price to reach UP to the level or DOWN to it" },
        level: { type: "number", description: "the real price level to watch" },
        reason: { type: "string", description: "your own real thesis -- what this level is and what you'd do if price gets there" },
      },
    },
    execute: async (args, ctx) =>
      createWatch(ctx.userId, {
        symbol: args.symbol as string,
        kind: args.kind as WatchKind,
        level: args.level as number,
        reason: args.reason as string,
      }),
  },
  {
    name: "check_marked_levels",
    description:
      "List your own background checks that are still pending -- what you're waiting on, at what level, and the reason you set each one. " +
      "Check this before marking a new level so you don't stack duplicates on the same thing.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => ({ pending: listActiveWatches(ctx.userId) }),
  },
  {
    name: "cancel_marked_level",
    description: "Stop one of your pending background checks by id (from check_marked_levels) -- e.g. the thesis behind it no longer holds.",
    parameters: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    execute: async (args, ctx) => cancelWatch(ctx.userId, args.id as string),
  },
  {
    // Self-Awareness spec part 4: record what you EXPECT before a trade, so it can be compared to
    // reality after it closes.
    name: "record_trade_expectation",
    description:
      "Before or just after opening a trade, record what you expect to happen -- so your prediction can be scored against reality later. " +
      "Pass the ticket and your read: expected target price, how long you think it'll take (minutes), the worst drawdown you'd tolerate (% ), your confidence, " +
      "what behaviour you expect, the timeframe, and setup tags (e.g. 'liquidity-sweep', 'OB-retest') used to find similar past trades. This is how you learn whether your calls actually play out.",
    parameters: {
      type: "object",
      required: ["ticket", "symbol", "direction"],
      properties: {
        ticket: { type: "string" },
        symbol: { type: "string" },
        direction: { type: "string", enum: ["buy", "sell"] },
        timeframe: { type: "string" },
        setupTags: { type: "array", items: { type: "string" } },
        expectedTarget: { type: "number" },
        expectedTimeMinutes: { type: "number" },
        expectedMaxDrawdownPct: { type: "number" },
        confidence: { type: "number" },
        expectedBehavior: { type: "string" },
      },
    },
    execute: async (args, ctx) =>
      recordExpectation(ctx.userId, {
        ticket: args.ticket as string,
        symbol: args.symbol as string,
        direction: args.direction as "buy" | "sell",
        timeframe: args.timeframe as string | undefined,
        setupTags: args.setupTags as string[] | undefined,
        expectedTarget: args.expectedTarget as number | undefined,
        expectedTimeMinutes: args.expectedTimeMinutes as number | undefined,
        expectedMaxDrawdownPct: args.expectedMaxDrawdownPct as number | undefined,
        confidence: args.confidence as number | undefined,
        expectedBehavior: args.expectedBehavior as string | undefined,
      }),
  },
  {
    // Self-Awareness spec part 5: search past trades for similar setups before entering a new one.
    name: "find_similar_setups",
    description:
      "Before entering, search your OWN past closed trades for setups like this one (same symbol + direction, optionally same timeframe / setup tags). " +
      "Returns how many similar trades you've taken, how many worked vs failed, the win rate, and the average time to outcome -- real experience to weigh the new trade against. " +
      "Empty until you've closed some trades; it grows automatically as trades close.",
    parameters: {
      type: "object",
      required: ["symbol", "direction"],
      properties: {
        symbol: { type: "string" },
        direction: { type: "string", enum: ["buy", "sell"] },
        timeframe: { type: "string" },
        setupTags: { type: "array", items: { type: "string" } },
      },
    },
    execute: async (args, ctx) =>
      findSimilarSetups(ctx.userId, {
        symbol: args.symbol as string,
        direction: args.direction as "buy" | "sell",
        timeframe: args.timeframe as string | undefined,
        setupTags: args.setupTags as string[] | undefined,
      }),
  },
  {
    name: "review_prediction_accuracy",
    description: "See how your predictions have held up overall -- total trades scored, how often the thesis was right, and your expected vs actual time-to-outcome. Your own track record.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => predictionAccuracySummary(ctx.userId),
  },
  {
    name: "get_min_risk_reward",
    description:
      "Get the user's own minimum risk:reward floor -- the ratio a trade's target must pay relative to what its stop risks. " +
      "A trade below this is refused rather than placed. 1 means 'never risk more than the trade stands to gain'.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => ({ minRiskReward: getMinRiskReward(ctx.userId) }),
  },
  {
    name: "set_min_risk_reward",
    description:
      "Set the user's minimum risk:reward floor (e.g. 1 for even money, 2 to require a trade to pay double what it risks). " +
      "Applies to every trade from then on, both your autonomous cycles and direct trade_execute calls.",
    parameters: { type: "object", required: ["minRiskReward"], properties: { minRiskReward: { type: "number" } } },
    execute: async (args, ctx) => setMinRiskReward(ctx.userId, args.minRiskReward as number),
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
