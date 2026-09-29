import type { TradeExecutor } from "@dave/trading";
import { tradeModify, partialClose, fullClose, deletePendingOrder } from "@dave/trading";
import { ALL_ANALYSIS_ENDPOINTS } from "@dave/trading";

/**
 * Several things in one scan (the trader: "mode 2 -- make sure the agent can call 2 tools and more
 * at the same time, e.g. get candles AND put breakeven AND get volatility"). The decision tool
 * stays one forced call; `actions` rides alongside the main action:
 *
 *   - trade-management items (BREAKEVEN, MODIFY, PARTIAL_CLOSE, CLOSE) run together, in parallel,
 *     right away -- whatever the main action is;
 *   - data items (GET) are all fetched in parallel, and Dave decides once more with every result in
 *     hand. Still bounded: one gather round per scan, never a loop.
 */

export const MAX_TICK_ACTIONS = 6;

/** Reads mode 2 can ask for that are NOT part of the per-timeframe analysis suite (get_all_analysis):
 *  mtf = the multi-timeframe summary (M5/M15/H1/H4/D1 in one read; the trader: "add this as a tool in
 *  the mode 2 -- it shouldn't be in the get all analysis"), adx, and the symbol's contract/hours. */
export const MODE2_EXTRA_ENDPOINTS = ["mtf", "adx", "symbol_info"];

export type TickAction =
  | { type: "BREAKEVEN"; ticket: string; offset?: number }
  | { type: "MODIFY"; ticket: string; sl?: number | null; tp?: number | null }
  | { type: "PARTIAL_CLOSE"; ticket: string; lots: number }
  | { type: "CLOSE"; ticket: string }
  | { type: "GET"; endpoint: string; symbol?: string; timeframe?: string };

export interface TickPositionLike {
  ticket: string;
  symbol: string;
  type: string;
  openPrice: number;
  currentPrice?: number;
  sl?: number;
  tp?: number;
}

export const ACTIONS_SCHEMA = {
  type: "array",
  maxItems: MAX_TICK_ACTIONS,
  description:
    "OPTIONAL, on ANY decision -- extra things to do in this same scan, all at once (up to 6). " +
    "Trade management runs immediately and in parallel, whatever your main action is: " +
    "{type:'BREAKEVEN', ticket, offset?} moves a winning trade's stop to its entry (offset = extra price distance in the trade's favour); " +
    "{type:'MODIFY', ticket, sl?, tp?}; {type:'PARTIAL_CLOSE', ticket, lots}; {type:'CLOSE', ticket} (closes a position or deletes a pending order). " +
    "Data: {type:'GET', endpoint, symbol? (default: the pair you're scanning), timeframe? (default M5)} -- endpoint is one of candles, volatility, momentum, trend, structure, zones, liquidity, divergence, session, levels, patterns, ict, synthetic, risk_metrics, strength, correlation (and the other analysis categories), " +
    "or mtf (the multi-timeframe summary: SMMA trend score, RSI, ATR and ADX on M5/M15/H1/H4/D1 in one read -- timeframe is ignored), adx, symbol_info (contract, stop distance, trading hours, market open?). " +
    "If you list ANY GET item, all of them are fetched together and you decide ONCE more with the results -- your main action this time is only a placeholder (SKIP is fine), " +
    "and on that second decision GET items are ignored. Use it when you genuinely need 2+ fresh reads, not as a routine step.",
  items: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["BREAKEVEN", "MODIFY", "PARTIAL_CLOSE", "CLOSE", "GET"] },
      ticket: { type: "string" },
      offset: { type: "number" },
      sl: { type: ["number", "null"] },
      tp: { type: ["number", "null"] },
      lots: { type: "number" },
      endpoint: { type: "string" },
      symbol: { type: "string" },
      timeframe: { type: "string" },
    },
    required: ["type"],
  },
} as const;

const TIMEFRAMES = new Set(["M1", "M3", "M5", "M15", "M30", "H1", "H4", "D1", "W1"]);

/** Parses the model's raw `actions` array, dropping anything malformed. */
export function coerceTickActions(raw: unknown): TickAction[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: TickAction[] = [];
  for (const item of raw.slice(0, MAX_TICK_ACTIONS)) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    const type = String(a.type ?? "").toUpperCase();
    const ticket = a.ticket === undefined || a.ticket === null ? "" : String(a.ticket).replace(/^#/, "").trim();
    if (type === "BREAKEVEN" && ticket) out.push({ type, ticket, offset: typeof a.offset === "number" && a.offset > 0 ? a.offset : undefined });
    else if (type === "MODIFY" && ticket) {
      const sl = typeof a.sl === "number" ? a.sl : "sl" in a && a.sl === null ? null : undefined;
      const tp = typeof a.tp === "number" ? a.tp : "tp" in a && a.tp === null ? null : undefined;
      if (sl !== undefined || tp !== undefined) out.push({ type, ticket, sl, tp });
    } else if (type === "PARTIAL_CLOSE" && ticket && typeof a.lots === "number" && a.lots > 0) out.push({ type, ticket, lots: a.lots });
    else if (type === "CLOSE" && ticket) out.push({ type, ticket });
    else if (type === "GET" && typeof a.endpoint === "string") {
      const endpoint = a.endpoint.trim().toLowerCase().replace(/^get_/, "");
      if (!(ALL_ANALYSIS_ENDPOINTS as readonly string[]).includes(endpoint) && !MODE2_EXTRA_ENDPOINTS.includes(endpoint)) continue;
      const tf = typeof a.timeframe === "string" ? a.timeframe.trim().toUpperCase() : undefined;
      out.push({ type, endpoint, symbol: typeof a.symbol === "string" && a.symbol.trim() ? a.symbol.trim() : undefined, timeframe: tf && TIMEFRAMES.has(tf) ? tf : undefined });
    }
  }
  return out.length ? out : undefined;
}

export const isDataAction = (a: TickAction): a is Extract<TickAction, { type: "GET" }> => a.type === "GET";

export interface ActionResult {
  action: TickAction;
  ok: boolean;
  /** One line, plain words, for the log and the trader. */
  text: string;
}

/** Runs every trade-management item in parallel. Never throws: each item reports its own result. */
export async function runManagementActions(
  executor: TradeExecutor,
  actions: TickAction[],
  positions: TickPositionLike[],
  pendingTickets: string[]
): Promise<ActionResult[]> {
  const items = actions.filter((a) => !isDataAction(a));
  // Two items on the same ticket would race each other at the broker -- keep the first only.
  const seen = new Set<string>();
  const unique = items.filter((a) => {
    const t = (a as { ticket: string }).ticket;
    if (seen.has(t)) return false;
    seen.add(t);
    return true;
  });
  return Promise.all(unique.map((a) => runOne(executor, a, positions, pendingTickets)));
}

async function runOne(executor: TradeExecutor, a: TickAction, positions: TickPositionLike[], pendingTickets: string[]): Promise<ActionResult> {
  if (a.type === "GET") return { action: a, ok: false, text: "not a management action" };
  const p = positions.find((x) => String(x.ticket) === a.ticket);
  try {
    if (a.type === "CLOSE") {
      if (pendingTickets.includes(a.ticket)) {
        await deletePendingOrder(executor, a.ticket);
        return { action: a, ok: true, text: `🗑 pending order #${a.ticket} deleted` };
      }
      if (!p) return { action: a, ok: false, text: `CLOSE #${a.ticket}: no such open trade or pending order` };
      await fullClose(executor, a.ticket);
      return { action: a, ok: true, text: `🗑 #${a.ticket} ${p.symbol} closed` };
    }
    if (!p) return { action: a, ok: false, text: `${a.type} #${a.ticket}: no such open trade` };
    if (a.type === "PARTIAL_CLOSE") {
      const r = await partialClose(executor, a.ticket, a.lots);
      return { action: a, ok: true, text: `✂️ #${a.ticket} ${p.symbol}: closed ${a.lots} lots (${r.remainingLots} left)` };
    }
    if (a.type === "MODIFY") {
      await tradeModify(executor, a.ticket, { sl: a.sl, tp: a.tp });
      const parts = [a.sl !== undefined ? `SL ${p.sl ?? "none"} → ${a.sl ?? "none"}` : null, a.tp !== undefined ? `TP ${p.tp ?? "none"} → ${a.tp ?? "none"}` : null].filter(Boolean);
      return { action: a, ok: true, text: `✏️ #${a.ticket} ${p.symbol}: ${parts.join(", ")}` };
    }
    // BREAKEVEN -- the same guards as the chat's set_breakeven tool.
    const buy = p.type.toLowerCase().startsWith("buy");
    const level = buy ? p.openPrice + (a.offset ?? 0) : p.openPrice - (a.offset ?? 0);
    const price = p.currentPrice;
    if (price === undefined || (buy ? price <= level : price >= level)) return { action: a, ok: false, text: `breakeven #${a.ticket} ${p.symbol}: not in profit past ${level} yet (now ${price ?? "unknown"})` };
    if (p.sl !== undefined && p.sl !== 0 && (buy ? p.sl >= level : p.sl <= level)) return { action: a, ok: false, text: `breakeven #${a.ticket} ${p.symbol}: stop already at ${p.sl}` };
    await tradeModify(executor, a.ticket, { sl: level });
    return { action: a, ok: true, text: `🛡 #${a.ticket} ${p.symbol}: stop moved to breakeven ${level}` };
  } catch (err) {
    return { action: a, ok: false, text: `${a.type} #${a.ticket} failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export interface AnalysisGetter {
  get<T>(endpoint: string, symbol: string, timeframe: string, opts?: { timeoutMs?: number }): Promise<T>;
}

/** Fetches every GET item at once. Returns one block of text for the re-decision. */
export async function gatherData(analysis: AnalysisGetter, actions: TickAction[], defaultSymbol: string, timeoutMs = 60_000): Promise<{ lines: string[]; fetched: number; failed: number }> {
  const gets = actions.filter(isDataAction);
  const results = await Promise.all(
    gets.map(async (g) => {
      const sym = g.symbol ?? defaultSymbol;
      const tf = g.timeframe ?? "M5";
      try {
        const data = await analysis.get<unknown>(g.endpoint, sym, tf, { timeoutMs });
        return { ok: true, line: `${g.endpoint.toUpperCase()} ${sym} ${tf}: ${JSON.stringify(data).slice(0, Math.floor(24_000 / Math.max(1, gets.length)))}` };
      } catch (err) {
        return { ok: false, line: `${g.endpoint.toUpperCase()} ${sym} ${tf}: failed -- ${err instanceof Error ? err.message : String(err)}` };
      }
    })
  );
  return { lines: results.map((r) => r.line), fetched: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}
