import { getLastKnownState, readClosedTradeHistory } from "@dave/ea-bridge";
import { activityAfter } from "./activity-bus.js";

/**
 * The self-aware alerts that fired recently, handed back to Dave himself (the trader: "confirm the
 * self aware is hitting the bot and update the self aware prompt so the bot knows what to do at
 * that point"). The monitor's alerts went to Telegram and the app only -- Dave's own next decision
 * never saw that a trade had been losing for ten minutes, recovered, stalled or neared its target.
 */

// Every background alert that can change what Dave should do with a trade or the account: the trade
// monitor (and its 5-minute reviews), marked levels, setups, the pullback scalp, the daily loss
// pause, safety checks, copy-trade notes, the trader's own stop/target edits, and health alerts.
const LABELS: Record<string, string> = {
  self_aware: "trade monitor",
  level_hit: "marked level",
  setup: "setup",
  scalp: "pullback scalp",
  drawdown: "daily loss limit",
  safety: "safety check",
  nous_note: "signal copy",
  trade_modified: "trader edited a trade",
  alert: "system alert",
};
const KINDS = new Set(Object.keys(LABELS));
/** Kept per prompt -- enough that a busy trade can't push another trade's alert out. */
const MAX_ALERTS = 10;

export function recentSelfAwareAlerts(userId: string, windowMs = 60 * 60_000, max = MAX_ALERTS, now = Date.now()): { at: number; kind: string; text: string }[] {
  return activityAfter(userId, 0, ["background"])
    .filter((e) => KINDS.has(e.kind) && now - e.at <= windowMs && typeof e.data.text === "string")
    .slice(-max)
    .map((e) => ({ at: e.at, kind: e.kind, text: String(e.data.text).replace(/\s+/g, " ").slice(0, 400) }));
}

const TICKET = /#(\d{5,})/g;

/** One block for a prompt, or null when nothing fired.
 *
 *  An alert about a trade that has since closed is left out, and the recently closed tickets are
 *  named as closed (seen live: Dave kept trying to move #1237942718 to breakeven in scan after scan
 *  after it had closed -- the alerts about it were still in this block). */
export function selfAwareFeedBlock(userId: string, windowMs?: number, now = Date.now(), only?: { symbol?: string; exclude?: string }): string | null {
  const open = new Set(getLastKnownState(userId).positions.map((p) => String(p.ticket)));
  const closedNow = new Set<string>();
  const items = recentSelfAwareAlerts(userId, windowMs, MAX_ALERTS * 2, now)
    // One thing per scan: only alerts about this pair (a word match on its name), and not the
    // alert that started this scan (it's already on top of the prompt).
    .filter((i) => !only?.symbol || new RegExp(`\\b${only.symbol.replace(/[^A-Za-z0-9_]/g, "")}\\b`, "i").test(i.text))
    .filter((i) => !only?.exclude || i.text !== only.exclude.replace(/\s+/g, " ").slice(0, 400))
    .filter((i) => {
      const tickets = [...i.text.matchAll(TICKET)].map((m) => m[1]);
      if (!tickets.length || tickets.some((t) => open.has(t))) return true;
      for (const t of tickets) closedNow.add(t);
      return false;
    })
    .slice(-MAX_ALERTS);
  const window = windowMs ?? 60 * 60_000;
  const recentlyClosed = readClosedTradeHistory(userId)
    .filter((c) => now - c.closedAt <= window && !open.has(String(c.ticket)) && (!only?.symbol || c.symbol.toUpperCase() === only.symbol.toUpperCase()))
    .slice(-8);
  for (const c of recentlyClosed) closedNow.add(String(c.ticket));
  if (!items.length && !closedNow.size) return null;
  const lines = items.map((i) => `- ${Math.max(0, Math.round((now - i.at) / 60_000))} min ago [${LABELS[i.kind] ?? i.kind}]: ${i.text}`);
  const closedLine = closedNow.size
    ? `ALREADY CLOSED -- these trades are gone; never breakeven, modify, close or ask about them: ${[...closedNow]
        .map((t) => {
          const c = recentlyClosed.find((r) => String(r.ticket) === t);
          return c ? `#${t} ${c.symbol}${typeof c.pnl === "number" ? ` (${c.pnl >= 0 ? "+" : ""}${c.pnl.toFixed(2)})` : ""}` : `#${t}`;
        })
        .join(", ")}. Only the tickets under OPEN POSITIONS exist.`
    : null;
  if (!items.length) return closedLine;
  return [
    "SELF-AWARE ALERTS (your own monitor, fired recently -- the trader has seen these too):",
    ...lines,
    "Respond to each still-relevant one per the self-aware rules in your prompt: act (breakeven, tighten, partial close, cut) or say in one line why the idea still holds. Never ignore one silently.",
    ...(closedLine ? [closedLine] : []),
  ].join("\n");
}
