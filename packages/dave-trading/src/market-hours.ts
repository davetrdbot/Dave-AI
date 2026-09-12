/**
 * Real gap fixed (user, live: "whether market is closed that's for forex it shouldn't analyze
 * that even set as fallback too -- it just analyze the active pair group/active pair"). Nothing
 * in this codebase previously knew whether a specific SYMBOL's real-world market was open --
 * only `trading-session-config.ts`'s isWithinSelectedSession, a separate, user-chosen UTC window
 * concept, unrelated to whether forex itself is genuinely tradable right now. Per the user's
 * explicit scope: forex only for now (the one category they called out) -- synthetics and every
 * other category stay always-open until real hours are confirmed for them.
 */

/** Real gap fixed (confirmed by a real test regression): a bare 6-letter-A-Z shape check also
 *  matches metals (XAUUSD, XAGUSD, XPTUSD, XPDUSD) -- DEFAULT_PAIR_GROUPS' own "metals" group,
 *  never forex, even though the ticker shape looks identical. These are excluded explicitly from
 *  the shape-sniffing fallback below, since they're the one well-known real exception. */
const KNOWN_NON_FOREX_SHAPE_MATCHES = new Set(["XAUUSD", "XAGUSD", "XPTUSD", "XPDUSD"]);

/** DEFAULT_PAIR_GROUPS' "forex" id (pair-groups.ts) is authoritative when known. A custom/
 *  "fallback" group has no fixed category, so fall back to symbol-shape sniffing: a plain
 *  6-letter A-Z currency-pair shape (e.g. EURUSD) -- never wrongly block a synthetic/metal/
 *  stock/crypto symbol just because it happens to be sitting in an uncategorized group. */
export function isForexSymbol(symbol: string, groupId: string | null | undefined): boolean {
  if (groupId === "forex") return true;
  if (groupId && groupId !== "fallback") return false;
  const upper = symbol.toUpperCase();
  if (KNOWN_NON_FOREX_SHAPE_MATCHES.has(upper)) return false;
  return /^[A-Z]{6}$/.test(upper);
}

/** Real forex weekend closure: Friday 22:00 UTC through Sunday 22:00 UTC. Mirrors
 *  trading-session-config.ts's own getUTCDay()/getUTCHours() style rather than a new idiom. */
export function isForexMarketOpen(now: Date = new Date()): boolean {
  const day = now.getUTCDay(); // 0 = Sunday, 5 = Friday, 6 = Saturday
  const hour = now.getUTCHours();
  if (day === 6) return false; // all Saturday
  if (day === 5 && hour >= 22) return false; // Friday from 22:00 UTC
  if (day === 0 && hour < 22) return false; // Sunday before 22:00 UTC
  return true;
}

export interface MarketHoursResult {
  open: boolean;
  reason: string;
}

/** The one real check callers use: is this specific symbol's real market open right now, given
 *  which group it's being scanned from. Always open for anything not recognized as forex. */
export function isMarketOpenForSymbol(symbol: string, groupId: string | null | undefined, now: Date = new Date()): MarketHoursResult {
  if (isForexSymbol(symbol, groupId) && !isForexMarketOpen(now)) {
    return { open: false, reason: "forex market closed (weekend)" };
  }
  return { open: true, reason: "" };
}
