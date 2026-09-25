import type { Provider } from "@dave/brain";
import type { ParsedSignal, SignalOrderKind, SignalSide } from "./store.js";

/**
 * Turns a signal channel's post into levels (or decides it isn't a new signal at all). Providers
 * write signals a hundred ways -- "GOLD BUY NOW 2350-2346 SL 2340 TP1 2356 TP2 2365", emoji cards,
 * a paragraph of reasoning -- so the reading is done by the model, forced through one tool call,
 * and the result is then checked by plain code: nothing reaches an order without real numbers on
 * the right sides.
 */

/** Cheap gate before spending a model call: a new signal names a direction and carries numbers. */
export function looksLikeSignal(text: string): boolean {
  return /\b(buy|sell|long|short)\b/i.test(text) && (text.match(/\d+(?:[.,]\d+)?/g) ?? []).length >= 2;
}

const TOOL = {
  name: "report_signal",
  description: "Report whether this message is a NEW trade signal, and its levels if so.",
  parameters: {
    type: "object",
    required: ["isSignal"],
    properties: {
      isSignal: {
        type: "boolean",
        description:
          "true ONLY for a new trade to open now or at a level. false for results ('TP1 hit', 'SL hit', '+50 pips'), updates to an old trade ('move SL to BE', 'close now'), analysis without a trade, promotions, and anything missing a stop loss or a take profit.",
      },
      symbol: {
        type: "string",
        description: "The MT5 symbol, uppercase, no slash: GOLD/XAU -> XAUUSD, SILVER -> XAGUSD, 'EUR/USD' -> EURUSD, US30/DOW -> US30, NAS100/NASDAQ -> NAS100, BTC -> BTCUSD, OIL -> USOIL. Synthetic indices exactly as written (e.g. VOL_75, BOOM_1000).",
      },
      side: { type: "string", enum: ["buy", "sell"] },
      orderKind: { type: "string", enum: ["market", "limit", "stop"], description: "'market' for buy/sell now; 'limit' for buy/sell limit; 'stop' for buy/sell stop." },
      entryLow: { type: "number", description: "Entry price, or the low end of an entry range. Omit for 'buy now' with no price." },
      entryHigh: { type: "number", description: "High end of an entry range; omit for a single price." },
      sl: { type: "number", description: "Stop loss price." },
      tp1: { type: "number", description: "First take profit price." },
      tp2: { type: "number", description: "Second take profit price, if given." },
      reason: { type: "string", description: "The provider's reason for the trade, in their own words (structure, zone, news...). Empty if none given." },
    },
  },
};

const SYSTEM =
  "You read trading signal posts from Telegram channels and report them through report_signal. Be strict: only a NEW trade with a stop loss and at least one take profit is a signal. Prices are the numbers in the post -- never invent, round or calculate a level that isn't written. Pips-only levels (\"SL 30 pips\") are not prices: report isSignal false for those.";

export async function parseSignal(provider: Provider, text: string, timeoutMs = 60_000): Promise<ParsedSignal | undefined> {
  if (!looksLikeSignal(text)) return undefined;
  const result = await provider.generate(
    {
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: text.slice(0, 4000) },
      ],
      tools: [TOOL],
      toolChoice: { name: TOOL.name },
      maxTokens: 600,
    },
    timeoutMs,
  );
  const call = result.toolCalls?.find((c) => c.name === TOOL.name);
  return call ? normalizeSignal(call.arguments) : undefined;
}

/** Common nicknames providers use, to the MT5 name -- plain code, so it holds whatever the model writes. */
const SYMBOL_ALIASES: Record<string, string> = {
  GOLD: "XAUUSD", XAU: "XAUUSD", SILVER: "XAGUSD", XAG: "XAGUSD",
  OIL: "USOIL", WTI: "USOIL", CRUDE: "USOIL", BRENT: "UKOIL",
  DOW: "US30", DJ30: "US30", DJI: "US30", NASDAQ: "NAS100", NAS: "NAS100", US100: "NAS100", USTEC: "NAS100",
  SPX: "SPX500", SP500: "SPX500", US500: "SPX500", DAX: "GER40", GER30: "GER40", DE40: "GER40",
  BTC: "BTCUSD", BITCOIN: "BTCUSD", ETH: "ETHUSD",
};

/** Plain-code check of what the model reported. Undefined = not a usable signal. */
export function normalizeSignal(a: Record<string, unknown>): ParsedSignal | undefined {
  if (a.isSignal !== true) return undefined;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : typeof v === "string" && Number(v) > 0 ? Number(v) : undefined);
  const raw = typeof a.symbol === "string" ? a.symbol.trim().toUpperCase().replace(/[/\s]/g, "") : "";
  const symbol = SYMBOL_ALIASES[raw] ?? raw;
  const side = a.side === "buy" || a.side === "sell" ? (a.side as SignalSide) : undefined;
  const orderKind: SignalOrderKind = a.orderKind === "limit" || a.orderKind === "stop" ? a.orderKind : "market";
  const sl = num(a.sl);
  const tp1 = num(a.tp1);
  if (!/^[A-Z0-9_.#+-]{2,32}$/.test(symbol) || !side || sl === undefined || tp1 === undefined) return undefined;
  const lo = num(a.entryLow);
  const hi = num(a.entryHigh);
  const entry = lo !== undefined && hi !== undefined ? (lo + hi) / 2 : (lo ?? hi);
  const dir = side === "buy" ? 1 : -1;
  if (!(dir * (tp1 - sl) > 0)) return undefined; // TP and SL on the wrong sides for this direction
  let tp2 = num(a.tp2);
  if (tp2 !== undefined && !(dir * (tp2 - tp1) > 0)) tp2 = undefined; // TP2 must be beyond TP1
  return {
    symbol,
    side,
    orderKind: entry === undefined ? "market" : orderKind,
    entry,
    sl,
    tp1,
    tp2,
    reason: typeof a.reason === "string" ? a.reason.trim().slice(0, 1500) : "",
  };
}
