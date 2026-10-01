/**
 * Who opened a trade (the trader: "it doesn't even know when I was the one who opened it"). Seen
 * live: the trader opened BOOM_100 SELL by hand, and Dave's scan called it "my open BOOM_100 SELL"
 * and invented the idea behind it. The EA (3.0+) says whether its own magic number placed it; a
 * copied signal carries the comment "Nous signal".
 */
export type TradeOwner = "dave" | "trader" | "signal" | "unknown";

export function tradeOwner(p: { byDave?: boolean; comment?: string }): TradeOwner {
  if (/^nous/i.test(p.comment ?? "")) return "signal";
  if (p.byDave === true) return "dave";
  if (p.byDave === false) return "trader";
  return "unknown";
}

/** A short tag for prompts and alerts; empty for Dave's own trades. */
export function ownerTag(p: { byDave?: boolean; comment?: string }): string {
  switch (tradeOwner(p)) {
    case "trader":
      return "OPENED BY THE TRADER BY HAND (not your trade -- there is no idea of yours behind it; protect it, never call it yours)";
    case "signal":
      return "COPIED SIGNAL (copy trading opened it from a channel)";
    default:
      return "";
  }
}
