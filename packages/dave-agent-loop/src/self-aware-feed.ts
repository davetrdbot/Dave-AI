import { activityAfter } from "./activity-bus.js";

/**
 * The self-aware alerts that fired recently, handed back to Dave himself (the trader: "confirm the
 * self aware is hitting the bot and update the self aware prompt so the bot knows what to do at
 * that point"). The monitor's alerts went to Telegram and the app only -- Dave's own next decision
 * never saw that a trade had been losing for ten minutes, recovered, stalled or neared its target.
 */

const KINDS = new Set(["self_aware", "level_hit", "setup"]);

export function recentSelfAwareAlerts(userId: string, windowMs = 60 * 60_000, max = 6, now = Date.now()): { at: number; kind: string; text: string }[] {
  return activityAfter(userId, 0, ["background"])
    .filter((e) => KINDS.has(e.kind) && now - e.at <= windowMs && typeof e.data.text === "string")
    .slice(-max)
    .map((e) => ({ at: e.at, kind: e.kind, text: String(e.data.text).replace(/\s+/g, " ").slice(0, 400) }));
}

/** One block for a prompt, or null when nothing fired. */
export function selfAwareFeedBlock(userId: string, windowMs?: number, now = Date.now()): string | null {
  const items = recentSelfAwareAlerts(userId, windowMs, 6, now);
  if (!items.length) return null;
  const lines = items.map((i) => `- ${Math.max(0, Math.round((now - i.at) / 60_000))} min ago [${i.kind === "self_aware" ? "trade monitor" : i.kind === "level_hit" ? "marked level" : "setup"}]: ${i.text}`);
  return [
    "SELF-AWARE ALERTS (your own monitor, fired recently -- the trader has seen these too):",
    ...lines,
    "Respond to each still-relevant one per the self-aware rules in your prompt: act (breakeven, tighten, partial close, cut) or say in one line why the idea still holds. Never ignore one silently.",
  ].join("\n");
}
