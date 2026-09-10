import { getRiskSettings, getAutoApprovalEnabled, getActiveGroupInfo, getTradingSession, getTradingMode, type RiskMode } from "@dave/trading";
import { getConfidenceSettings } from "@dave/trading";
import { getEaConnectionStatus, getLastKnownAccountSnapshot } from "@dave/ea-bridge";
import type { ContentBlock } from "@dave/brain";

/**
 * Real bug fixed (user: "sets TP/SL to Auto, sets an active pair group -- the bot keeps asking
 * about these as if they were never set"). Root cause: the system prompt (SOUL/IDENTITY/SECURITY/
 * BOOTSTRAP) is a static, per-process string loaded ONCE at boot and frozen into history's first
 * message -- it carries zero live, per-user settings, and there was no other mechanism making a
 * saved setting visible to the model except the model happening to call the right get_* tool
 * every single turn, which it doesn't reliably do.
 *
 * This builds a fresh, real snapshot straight from the same stores /settings itself reads/writes,
 * on EVERY turn -- so a setting saved a moment ago is genuinely visible on the very next turn,
 * with real proof (not a memory/cache layer that could itself go stale). Deliberately NOT part of
 * the static system prompt (that would invalidate prompt caching's prefix match on every single
 * turn, per item 2) -- it rides on the CURRENT user message instead, which is inherently new and
 * uncached every turn anyway, so this costs nothing extra on the caching front.
 */
function modeLabel(mode: RiskMode, value?: number): string {
  if (mode === "off") return "off";
  if (mode === "auto") return "auto";
  return `on (${value})`;
}

export function buildLiveSettingsBlock(userId: string): string {
  const risk = getRiskSettings(userId);
  const group = getActiveGroupInfo(userId);
  const session = getTradingSession(userId);
  const tradingMode = getTradingMode(userId);
  const confidence = getConfidenceSettings(userId);
  const autoApproval = getAutoApprovalEnabled(userId);
  const ea = getEaConnectionStatus(userId);
  const account = getLastKnownAccountSnapshot(userId);

  const pairLine = group.activePairSymbol
    ? `Single-pair focus: ${group.activePairSymbol}`
    : `Active pair group: ${group.activeGroup?.name ?? "none set"}${group.fallbackGroup ? ` (fallback: ${group.fallbackGroup.name})` : ""}`;

  // Real gap fixed (item 5, user: "leverage is STILL not appearing in what the bot receives from
  // the EA"): the EA genuinely sends it and the bridge genuinely persists it (ea-webhook.ts), and
  // it was already reachable via the get_account_balance tool -- but that's tool-gated, so it
  // only shows up on a turn where the model happens to call it. Surfaced here instead, proactively
  // on EVERY turn (same pattern as every other setting in this block), so it's never missed.
  const accountLine = account
    ? `Account: balance ${account.balance} | equity ${account.equity} | margin ${account.margin} | free margin ${account.freeMargin}${account.leverage !== undefined ? ` | leverage 1:${account.leverage}` : " | leverage: not reported by the EA yet"}`
    : "Account: no EA report received yet";

  const lines = [
    "<current_settings>",
    `SL: ${modeLabel(risk.slMode, risk.slValue)} | TP: ${modeLabel(risk.tpMode, risk.tpValue)} | Lot: ${modeLabel(risk.lotMode, risk.lotValue)}`,
    pairLine,
    `Trading session: ${session}`,
    `Trading mode: ${tradingMode.mode}${tradingMode.lockedSkillId ? ` (locked to skill ${tradingMode.lockedSkillId})` : ""}`,
    `Confidence threshold: ${confidence.threshold}% (auto-approve below threshold: ${confidence.autoApproveBelowThreshold ? "on" : "off"})`,
    `Auto-approval of your own proposed changes: ${autoApproval ? "on" : "off"}`,
    `EA connection: ${ea.connected ? "connected" : "not connected"}`,
    accountLine,
    "</current_settings>",
    "",
    "These are the user's REAL, currently-saved settings, read fresh this turn -- never ask the user to re-confirm a value shown above, and never claim one isn't set when it's listed here.",
  ];
  return lines.join("\n");
}

/** Prepends the live settings block to a real user turn -- text or content-block (image) shape. */
export function withLiveContext(userId: string, content: string | ContentBlock[]): string | ContentBlock[] {
  const block = buildLiveSettingsBlock(userId);
  if (typeof content === "string") return `${block}\n\n${content}`;
  return [{ type: "text", text: block }, ...content];
}
