import { getLastKnownState } from "@dave/ea-bridge";
import { getActiveGroupInfo } from "@dave/trading";

/**
 * Whisper's vocabulary hint for the trader's voice (the trader: "so when I'm talking to Dave ...
 * it transcribes perfectly"). Whisper hears "XAUUSD" as "ex ay you US D", "Volatility 75" as
 * "volatility seventy-five" and "breakeven" as "break even"; a prompt listing the words to expect
 * fixes most of that. It carries the trader's own pairs (the active group and any open trade) and
 * the trading words Dave's commands turn on. Short on purpose -- Whisper reads ~224 tokens of it.
 */

const TERMS = [
  "Dave",
  "breakeven",
  "stop loss",
  "take profit",
  "SL",
  "TP",
  "risk:reward",
  "R:R",
  "pips",
  "lots",
  "buy limit",
  "sell limit",
  "buy stop",
  "sell stop",
  "partial close",
  "trailing stop",
  "order block",
  "fair value gap",
  "liquidity sweep",
  "market structure",
  "ATR",
  "RSI",
  "MACD",
  "M1",
  "M5",
  "M15",
  "H1",
  "H4",
  "Nous",
  "MT5",
  "XAUUSD",
];

/** Pair names as a trader says them: "Volatility 75 Index" stays, "XAUUSD" stays. */
function symbolsFor(userId: string): string[] {
  const out = new Set<string>();
  try {
    for (const p of getLastKnownState(userId).positions) out.add(p.symbol);
  } catch {
    /* no EA state yet */
  }
  try {
    for (const s of getActiveGroupInfo(userId).activeGroup?.symbols ?? []) out.add(s);
  } catch {
    /* no groups yet */
  }
  return [...out].slice(0, 25);
}

export function speechVocabularyPrompt(userId: string): string {
  const symbols = symbolsFor(userId);
  // Written as a sentence: Whisper follows a prompt's style, and a plain list can make it answer
  // in lists. Symbols first -- they're the words it gets wrong most.
  const text = `Trading chat with Dave about ${[...symbols, ...TERMS.filter((t) => !symbols.includes(t))].join(", ")}.`;
  return text.slice(0, 800);
}
