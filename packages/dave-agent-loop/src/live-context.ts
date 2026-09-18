import { getRiskSettings, getAutoApprovalEnabled, getActiveGroupInfo, getTradingSession, getTradingMode, getActiveStrategySkillId, TRADING_SESSION_WINDOWS_UTC, type RiskMode } from "@dave/trading";
import { getConfidenceSettings, getMinRiskReward } from "@dave/trading";
import { getEaConnectionStatus, getLastKnownAccountSnapshot } from "@dave/ea-bridge";
import { getSkill } from "@dave/skills";
import { loadFrozenSnapshot } from "@dave/memory";
import { knowledgeList } from "@dave/knowledge";
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

/**
 * Real bug fixed (the trader, live, after watching Dave reason about "~16:00 UTC" with no way to
 * actually know: "the bot doesn't know time"). Confirmed by grep: `new Date()` appeared only in
 * internal market-hours and self-pause checks -- nothing ever put the current time into the
 * model's context, so every statement Dave made about the time, the session, or how long a trade
 * had been running was a guess.
 *
 * Sessions here are the codebase's OWN windows (TRADING_SESSION_WINDOWS_UTC), not a second
 * hardcoded list that could drift from the gate that actually blocks trading.
 */
function openSessionsNow(now: Date): string[] {
  const hour = now.getUTCHours();
  return Object.entries(TRADING_SESSION_WINDOWS_UTC)
    .filter(([, w]) => (w.startHour <= w.endHour ? hour >= w.startHour && hour < w.endHour : hour >= w.startHour || hour < w.endHour))
    .map(([name]) => name);
}

export function buildClockLine(now: Date = new Date()): string {
  const iso = now.toISOString();
  const day = now.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
  const open = openSessionsNow(now);
  return `NOW: ${iso} (${day}, UTC) | sessions open right now: ${open.length > 0 ? open.join(", ") : "none"}`;
}

export function buildLiveSettingsBlock(userId: string): string {
  const risk = getRiskSettings(userId);
  const group = getActiveGroupInfo(userId);
  const session = getTradingSession(userId);
  const tradingMode = getTradingMode(userId);
  const confidence = getConfidenceSettings(userId);
  const autoApproval = getAutoApprovalEnabled(userId);
  const minRiskReward = getMinRiskReward(userId);
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
    // First line of the block on purpose: Dave had no clock at all, and everything below
    // (sessions, how long a position has run, whether a level is stale) is time-relative.
    buildClockLine(),
    `SL: ${modeLabel(risk.slMode, risk.slValue)} | TP: ${modeLabel(risk.tpMode, risk.tpValue)} | Lot: ${modeLabel(risk.lotMode, risk.lotValue)}`,
    pairLine,
    `Trading session: ${session}`,
    `Trading mode: ${tradingMode.mode}${tradingMode.lockedSkillId ? ` (locked to skill ${tradingMode.lockedSkillId})` : ""}`,
    `Confidence threshold: ${confidence.threshold}% (auto-approve below threshold: ${confidence.autoApproveBelowThreshold ? "on" : "off"})`,
    // Surfaced every turn for the same reason as every other setting in this block: a floor the
    // model cannot see is a floor it will keep tripping over. Settable via set_min_risk_reward.
    `Minimum risk:reward: ${minRiskReward}:1 (a trade whose stop risks more than its target pays is refused)`,
    `Auto-approval of your own proposed changes: ${autoApproval ? "on" : "off"}`,
    `EA connection: ${ea.connected ? "connected" : "not connected"}`,
    accountLine,
    "</current_settings>",
    "",
    "These are the user's REAL, currently-saved settings, read fresh this turn -- never ask the user to re-confirm a value shown above, and never claim one isn't set when it's listed here.",
  ];

  // Part 2 (skill scoping): a skill marked active by set_active_strategy_skill (or the Telegram
  // Trading Mode -> Trading Skills picker, same underlying store) is surfaced here, every turn,
  // as the real analysis lens for this cycle -- never something the model has to remember to go
  // fetch with get_active_strategy_skill on its own. Absent one, no block is added at all, and
  // prompts/trading.md's own default judgment/analysis-lens language governs instead -- there is
  // deliberately no "ask the user which strategy to use" path anywhere in this build.
  const activeSkillId = getActiveStrategySkillId(userId);
  if (activeSkillId) {
    const skill = getSkill(userId, activeSkillId);
    if (skill) {
      lines.push(
        "",
        "<active_strategy_skill>",
        `ACTIVE STRATEGY SKILL: "${skill.name}" -- follow this explicitly for every trade decision this turn. Use only the timeframes, endpoints, and signals this strategy actually calls for -- do NOT supplement it with other tools, timeframes, or indicators (e.g. adding M5 when it only calls for M1/M3, or pulling in EMA/Gann-fan levels it never mentions) "just to be safe". That is not extra diligence, it is silently trading a different strategy than the one the user activated.`,
        skill.description ? `Summary: ${skill.description}` : "",
        "Full instructions:",
        skill.content,
        "</active_strategy_skill>"
      );
    }
  }

  // Real bug fixed (the trader, explicit: "don't forget to check the memory"). Dave's memory was
  // write-only in practice. remember_user_fact / remember_note / remember_adaptability_note all
  // genuinely persist to disk, and prompts/BOOTSTRAP.md tells the model those saves are
  // mandatory -- but loadFrozenSnapshot had exactly two callers: the recall_memory TOOL and a
  // selftest. Nothing loaded memory into the system prompt or into any turn, so "remember I hate
  // XAUUSD" was saved and then never seen again unless the model spontaneously chose to call
  // recall_memory first.
  //
  // That is precisely the bug this module's own header describes for settings ("the bot keeps
  // asking about these as if they were never set... unless the model happens to call the right
  // get_* tool every single turn, which it doesn't reliably do"), so it gets the same, already
  // proven fix: read fresh every turn, ride on the user message rather than the cached system
  // prompt. The frozen snapshot is character-budgeted at the store (FROZEN_PAIR_CHAR_BUDGET), so
  // this cannot grow without bound the way an unbudgeted append would.
  const memory = safeLoadMemory(userId);
  if (memory) {
    lines.push(
      "",
      "<remembered>",
      memory,
      "</remembered>",
      "",
      "This is what you have genuinely remembered about this user, loaded fresh this turn. Treat it as already known -- never ask them to repeat something recorded here, and never claim you don't remember it.",
    );
  }

  // Real bug fixed, same class as the memory one above and found the same way: Dave's knowledge
  // store was UNREACHABLE in practice. All six knowledge tools are genuinely registered, but
  // knowledge is never injected into any prompt, and of the six only knowledge_view was in the
  // per-turn core tool list -- a reader that takes an id, with nothing in context ever telling the
  // model an id exists. So "check what you've learned" could only work if the model
  // spontaneously called search_tools first to discover a lister. It doesn't, and the store stays
  // empty forever.
  //
  // The index is deliberately just id/title/when-to-use -- that is all knowledgeList returns, and
  // it keeps the per-turn cost flat no matter how long an entry's body is. The body is fetched on
  // demand with knowledge_view, which is what that tool is for.
  const knowledge = safeLoadKnowledgeIndex(userId);
  if (knowledge) {
    lines.push(
      "",
      "<knowledge_index>",
      knowledge,
      "</knowledge_index>",
      "",
      "This is what you have genuinely learned and written down for yourself. Read the 'use when' of each and call knowledge_view on any that applies to what you're doing right now -- that is what they were saved for. When you learn something durable from a real trade, write a new one (knowledge_draft then knowledge_save -- both calls, or nothing is committed).",
    );
  }

  return lines.filter((l) => l !== "").join("\n");
}

/**
 * Memory must never be able to take down a turn. The store reads real files that this process has
 * genuinely crashed mid-write before, so a truncated or corrupt one is a real possibility -- a
 * trading cycle failing because a note file is malformed would be a strictly worse bug than the
 * one this fixes.
 */
function safeLoadMemory(userId: string): string | undefined {
  try {
    const snapshot = loadFrozenSnapshot(userId);
    // Deliberately NOT labelled with the real filenames. Dave was caught live naming an internal
    // prompt file to the trader ("he said trading.md to me -- is it supposed to make mention about
    // that to me"), and this block was one of the real feeders for that: the model saw
    // "MEMORY.md:" / "USER.md:" every single turn and reasonably echoed those names back as if
    // they were user-facing. Its own rules now forbid naming internals, so the context it reads
    // must not put them in front of it either.
    const sections = [
      snapshot.memory?.trim() ? `Things you've noted before:\n${snapshot.memory.trim()}` : "",
      snapshot.user?.trim() ? `About the person you work for:\n${snapshot.user.trim()}` : "",
      snapshot.adaptability?.trim() ? `How they want you to talk to them:\n${snapshot.adaptability.trim()}` : "",
    ].filter(Boolean);
    return sections.length > 0 ? sections.join("\n\n") : undefined;
  } catch (err) {
    console.error(`[live-context] could not load memory for ${userId} -- continuing without it:`, err);
    return undefined;
  }
}

/**
 * Same fail-safe contract as safeLoadMemory: a knowledge store that is missing, empty or corrupt
 * must cost the turn nothing at all.
 */
function safeLoadKnowledgeIndex(userId: string): string | undefined {
  try {
    const entries = knowledgeList(userId);
    if (entries.length === 0) return undefined;
    return entries.map((e) => `- [${e.id}] ${e.title} -- use when: ${e.useWhen}`).join("\n");
  } catch (err) {
    console.error(`[live-context] could not load knowledge for ${userId} -- continuing without it:`, err);
    return undefined;
  }
}

/** Prepends the live settings block to a real user turn -- text or content-block (image) shape. */
export function withLiveContext(userId: string, content: string | ContentBlock[]): string | ContentBlock[] {
  const block = buildLiveSettingsBlock(userId);
  if (typeof content === "string") return `${block}\n\n${content}`;
  return [{ type: "text", text: block }, ...content];
}
