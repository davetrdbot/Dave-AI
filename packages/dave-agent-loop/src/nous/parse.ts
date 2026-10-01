import type { CompletionMessage, ContentBlock, Provider, ToolCall } from "@dave/brain";
import type { ParsedSignal, ParsedUpdate, SignalOrderKind, SignalSide, UpdateAction } from "./store.js";

/**
 * Turns a signal channel's post -- text, a screenshot, or both -- into either a NEW signal, an
 * UPDATE to one Nous already copied ("close now", "move SL to BE", "SL to 2345"), or nothing.
 * Providers write these a hundred ways, so the reading is done by the model; it has one tool of
 * its own, get_price, to see the live market price (to turn "SL 30 pips" into a price, or to know
 * where "buy now" is). Whatever it reports is then checked by plain code: nothing reaches an order
 * without real numbers on the right sides.
 */

const SIGNAL_WORDS = /\b(buy|sell|long|short)\b/i;
const UPDATE_WORDS = /\b(close|closed|closing|exit|breakeven|break even|be|sl|stop|tp|cancel|delete|remove|secure|partial|partials|trail|move)\b/i;

/** Cheap gate before spending a model call. A picture always gets a look. While a trade copied from this channel is open,
 *  every post is read -- the levels, "HIT TP 1", or the provider's reason can come in any words
 *  (the trader: "when a message comes it should send to the bot so the bot can decide whether to
 *  skip"). */
export function worthReading(text: string, hasImage: boolean, hasOpenTrades: boolean): boolean {
  if (hasImage) return true;
  const numbers = (text.match(/\d+(?:[.,]\d+)?/g) ?? []).length;
  if (SIGNAL_WORDS.test(text) && (numbers >= 2 || /\bnow\b/i.test(text))) return true;
  if (hasOpenTrades) return text.trim().length >= 2;
  return false;
}

/** Kept for callers that only care about new signals. */
export function looksLikeSignal(text: string): boolean {
  return worthReading(text, false, false);
}

const REPORT = {
  name: "report_post",
  description: "Report what this post is. Call exactly once, after any get_price calls.",
  parameters: {
    type: "object",
    required: ["kind"],
    properties: {
      kind: {
        type: "string",
        enum: ["signal", "update", "note", "none"],
        description:
          "'signal' for a NEW trade with a stop loss and at least one take profit, OR an instant call like 'GOLD BUY NOW' / 'SELL XAUUSD NOW' with no levels (report symbol + side only -- the levels come in a later post), OR the levels (SL/TPs) for a copied trade listed as 'waiting for SL/TP' (report every level, same symbol and side). 'update' for an instruction or result about a trade already given (close, partial close, move SL to breakeven / a price, move TP, cancel a pending order, 'HIT TP 1' = tp_hit). 'note' for the provider explaining WHY they took a copied trade (structure, zone, news, the idea) -- put it in `reason`. 'none' for promotions, chatter, greetings, results of trades not listed.",
      },
      symbol: {
        type: "string",
        description: "The MT5 symbol, uppercase, no slash: GOLD/XAU -> XAUUSD, SILVER -> XAGUSD, 'EUR/USD' -> EURUSD, US30/DOW -> US30, NAS100/NASDAQ -> NAS100, BTC -> BTCUSD, OIL -> USOIL. Synthetic indices exactly as written (e.g. VOL_75, BOOM_1000). For an update, the pair it's about if named.",
      },
      side: { type: "string", enum: ["buy", "sell"] },
      orderKind: { type: "string", enum: ["market", "limit", "stop"], description: "'market' for buy/sell now; 'limit' for buy/sell limit; 'stop' for buy/sell stop." },
      entryLow: { type: "number", description: "Entry price, or the low end of an entry range. Omit for 'buy now' with no price." },
      entryHigh: { type: "number", description: "High end of an entry range; omit for a single price." },
      sl: { type: "number", description: "Stop loss PRICE." },
      tp1: { type: "number", description: "First take profit PRICE." },
      tp2: { type: "number", description: "Second take profit PRICE, if given." },
      tp3: { type: "number", description: "Third take profit PRICE, if given as a number." },
      tpOpen: { type: "boolean", description: "true when the last target is left open ('TP 3 : OPEN', 'TP3 open', 'let it run')." },
      reason: { type: "string", description: "The provider's reason for the trade, in their own words (structure, zone, news...). Empty if none given." },
      action: {
        type: "string",
        enum: ["close", "close_partial", "breakeven", "move_sl", "move_tp", "cancel", "tp_hit"],
        description: "For kind 'update': close = close it now; close_partial = take part off; breakeven = move SL to entry; move_sl / move_tp = to `price`; cancel = delete a pending order that hasn't filled; tp_hit = the provider says a target was hit ('HIT TP 1 ✅ +50 PIPS') -- set tpNumber. A 'TP hit' post that also says 'set BE' is still tp_hit.",
      },
      tpNumber: { type: "number", description: "For tp_hit: which target was hit (1, 2, 3...)." },
      price: { type: "number", description: "For move_sl / move_tp: the new level." },
      fraction: { type: "number", description: "For close_partial: the part to close, 0-1 (half = 0.5). Default 0.5." },
      all: { type: "boolean", description: "For an update: true when it clearly means every open trade from this channel ('close all')." },
    },
  },
};

const GET_PRICE = {
  name: "get_price",
  description: "The live bid/ask for a symbol from the trader's MT5 right now. Use it when the post gives levels in pips/points, says 'buy/sell now' without a price, or you need to know where price is to read the post correctly.",
  parameters: { type: "object", required: ["symbol"], properties: { symbol: { type: "string", description: "MT5 symbol, e.g. XAUUSD" } } },
};

const SYSTEM = [
  "You read posts from trading signal channels on Telegram (text and/or a screenshot of a signal) and report them with report_post.",
  "Be strict: a 'signal' is a NEW trade with a stop loss and at least one take profit, or an instant 'BUY NOW' / 'SELL NOW' call with no numbers (report only symbol + side). Prices are the numbers in the post -- never invent or guess a level.",
  "Many channels post 'GOLD BUY NOW' first, then a second post with the zone, TP1/TP2/TP3 and SL. The first is an instant 'signal' (symbol + side only); the second, when the copied trade is listed as 'waiting for SL/TP', is a 'signal' with every level. 'TP 3 : OPEN' means tpOpen true.",
  "'HIT TP 1' / 'TP2 done ✅' about a listed trade is an update with action tp_hit and tpNumber. The provider explaining why they took a listed trade is a 'note'.",
  "Levels given in pips: call get_price for the symbol, then convert from the entry (or the live price for 'now') using the pip size: XAUUSD 0.1, XAGUSD 0.01, JPY pairs 0.01, other forex pairs 0.0001. For indices, crypto and synthetics, points are price units (1 point = 1.0). If you can't convert confidently, report 'none'.",
  "An 'update' is only about a trade the channel already gave; the trades Nous copied from this channel are listed with the post.",
].join("\n");

export type ParsedPost = { kind: "signal"; signal: ParsedSignal } | { kind: "update"; update: ParsedUpdate } | { kind: "note"; note: string; symbol?: string } | undefined;

export interface ReadPostInput {
  text: string;
  image?: ContentBlock;
  /** One line per trade Nous copied from this channel that's still open or pending. */
  openTrades?: string[];
  /** The post replies to one of this channel's earlier signals Nous copied. */
  replyingTo?: string;
  /** The live price, for the model's get_price tool. */
  quote?: (symbol: string) => Promise<{ bid?: number; ask?: number } | undefined>;
}

const MAX_STEPS = 4;

export async function readPost(provider: Provider, input: ReadPostInput, timeoutMs = 60_000): Promise<ParsedPost> {
  if (!worthReading(input.text, !!input.image, !!input.openTrades?.length)) return undefined;
  const context = [
    input.replyingTo ? `This post REPLIES to your copied signal: ${input.replyingTo}` : "",
    input.openTrades?.length ? `Trades Nous copied from this channel, still open or pending:\n${input.openTrades.join("\n")}` : "No trades copied from this channel are open.",
  ].filter(Boolean).join("\n");
  const userContent: ContentBlock[] = [{ type: "text", text: `${context}\n\nThe post:\n${input.text.slice(0, 4000) || "(no text -- read the image)"}` }];
  if (input.image) userContent.push(input.image);
  const messages: CompletionMessage[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: userContent },
  ];
  const tools = input.quote ? [REPORT, GET_PRICE] : [REPORT];

  for (let step = 0; step < MAX_STEPS; step++) {
    // Free to look up prices first; the last step forces the report.
    const last = step === MAX_STEPS - 1;
    const result = await provider.generate({ messages, tools: last ? [REPORT] : tools, toolChoice: last || !input.quote ? { name: REPORT.name } : undefined, maxTokens: 800 }, timeoutMs);
    const calls = result.toolCalls ?? [];
    const report = calls.find((c) => c.name === REPORT.name);
    if (report) return normalizePost(report.arguments);
    const priceCalls = calls.filter((c) => c.name === GET_PRICE.name);
    if (!priceCalls.length) {
      // Answered in words instead of the tool: one forced try, then give up.
      if (step >= MAX_STEPS - 2) return undefined;
      messages.push({ role: "assistant", content: result.text || "(no answer)" }, { role: "user", content: "Report it with report_post now." });
      continue;
    }
    messages.push({ role: "assistant", content: result.text || "", toolCalls: calls });
    for (const call of priceCalls) messages.push({ role: "tool", toolCallId: call.id, content: await priceAnswer(call, input.quote!) });
  }
  return undefined;
}

async function priceAnswer(call: ToolCall, quote: NonNullable<ReadPostInput["quote"]>): Promise<string> {
  const symbol = normalizeSymbol(String(call.arguments.symbol ?? ""));
  try {
    const q = await quote(symbol);
    return q && (q.bid !== undefined || q.ask !== undefined) ? JSON.stringify({ symbol, bid: q.bid, ask: q.ask }) : JSON.stringify({ symbol, error: "no price -- the broker may name it differently, or MT5 is offline" });
  } catch (err) {
    return JSON.stringify({ symbol, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Back-compat: new signals only. */
export async function parseSignal(provider: Provider, text: string, timeoutMs = 60_000): Promise<ParsedSignal | undefined> {
  const post = await readPost(provider, { text }, timeoutMs);
  return post?.kind === "signal" ? post.signal : undefined;
}

/** Common nicknames providers use, to the MT5 name -- plain code, so it holds whatever the model writes. */
const SYMBOL_ALIASES: Record<string, string> = {
  GOLD: "XAUUSD", XAU: "XAUUSD", SILVER: "XAGUSD", XAG: "XAGUSD",
  OIL: "USOIL", WTI: "USOIL", CRUDE: "USOIL", BRENT: "UKOIL",
  DOW: "US30", DJ30: "US30", DJI: "US30", NASDAQ: "NAS100", NAS: "NAS100", US100: "NAS100", USTEC: "NAS100",
  SPX: "SPX500", SP500: "SPX500", US500: "SPX500", DAX: "GER40", GER30: "GER40", DE40: "GER40",
  BTC: "BTCUSD", BITCOIN: "BTCUSD", ETH: "ETHUSD",
};

export function normalizeSymbol(s: string): string {
  const raw = s.trim().toUpperCase().replace(/[/\s]/g, "");
  return SYMBOL_ALIASES[raw] ?? raw;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : typeof v === "string" && Number(v) > 0 ? Number(v) : undefined);
const UPDATE_ACTIONS: UpdateAction[] = ["close", "close_partial", "breakeven", "move_sl", "move_tp", "cancel", "tp_hit"];

/** Plain-code check of what the model reported. */
export function normalizePost(a: Record<string, unknown>): ParsedPost {
  if (a.kind === "signal" || a.isSignal === true) {
    const signal = normalizeSignal({ ...a, isSignal: true });
    return signal ? { kind: "signal", signal } : undefined;
  }
  if (a.kind === "update") {
    const action = UPDATE_ACTIONS.find((x) => x === a.action);
    if (!action) return undefined;
    const price = num(a.price);
    if ((action === "move_sl" || action === "move_tp") && price === undefined) return undefined;
    const tpNumber = typeof a.tpNumber === "number" ? Math.round(a.tpNumber) : Number(a.tpNumber);
    if (action === "tp_hit" && !(tpNumber >= 1 && tpNumber <= 6)) return undefined;
    const f = typeof a.fraction === "number" && a.fraction > 0 && a.fraction < 1 ? a.fraction : 0.5;
    const symbol = typeof a.symbol === "string" && a.symbol.trim() ? normalizeSymbol(a.symbol) : undefined;
    return { kind: "update", update: { action, symbol, price, fraction: action === "close_partial" ? f : undefined, tpNumber: action === "tp_hit" ? tpNumber : undefined, all: a.all === true } };
  }
  if (a.kind === "note") {
    const note = typeof a.reason === "string" ? a.reason.trim().slice(0, 1500) : "";
    if (note.length < 8) return undefined;
    const symbol = typeof a.symbol === "string" && a.symbol.trim() ? normalizeSymbol(a.symbol) : undefined;
    return { kind: "note", note, symbol };
  }
  return undefined;
}

/** A new signal's levels, checked. Undefined = not a usable signal. */
export function normalizeSignal(a: Record<string, unknown>): ParsedSignal | undefined {
  if (a.isSignal !== true && a.kind !== "signal") return undefined;
  const symbol = typeof a.symbol === "string" ? normalizeSymbol(a.symbol) : "";
  const side = a.side === "buy" || a.side === "sell" ? (a.side as SignalSide) : undefined;
  const orderKind: SignalOrderKind = a.orderKind === "limit" || a.orderKind === "stop" ? a.orderKind : "market";
  const sl = num(a.sl);
  const tp1 = num(a.tp1);
  const reason = typeof a.reason === "string" ? a.reason.trim().slice(0, 1500) : "";
  if (!/^[A-Z0-9_.#+-]{2,32}$/.test(symbol) || !side) return undefined;
  const lo = num(a.entryLow);
  const hi = num(a.entryHigh);
  const entry = lo !== undefined && hi !== undefined ? (lo + hi) / 2 : (lo ?? hi);
  // "GOLD BUY NOW": no stop, no target, no price -- in at market at once; the levels follow.
  if (sl === undefined && tp1 === undefined && entry === undefined) return { symbol, side, orderKind: "market", reason };
  if (sl === undefined || tp1 === undefined) return undefined;
  const dir = side === "buy" ? 1 : -1;
  if (!(dir * (tp1 - sl) > 0)) return undefined; // TP and SL on the wrong sides for this direction
  let tp2 = num(a.tp2);
  if (tp2 !== undefined && !(dir * (tp2 - tp1) > 0)) tp2 = undefined; // TP2 must be beyond TP1
  let tp3 = num(a.tp3);
  if (tp3 !== undefined && !(dir * (tp3 - (tp2 ?? tp1)) > 0)) tp3 = undefined;
  return {
    symbol,
    side,
    orderKind: entry === undefined ? "market" : orderKind,
    entry,
    zone: lo !== undefined && hi !== undefined && lo !== hi ? [Math.min(lo, hi), Math.max(lo, hi)] : undefined,
    sl,
    tp1,
    tp2,
    tp3,
    tpOpen: a.tpOpen === true || undefined,
    reason,
  };
}
