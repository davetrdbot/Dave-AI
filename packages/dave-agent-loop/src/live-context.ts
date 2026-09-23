import { getRiskSettings, getAutoApprovalEnabled, getActiveGroupInfo, getTradingSession, getTradingMode, getActiveStrategySkillId, TRADING_SESSION_WINDOWS_UTC, type RiskMode } from "@dave/trading";
import { getConfidenceSettings, getMinRiskReward, getDeepLossAlertPercent, getAlertToggles, getWinStreak, ALERT_CATEGORIES } from "@dave/trading";
import { listOpenMonitors, HOT_HAND_MIN_STREAK, isRanging, PEAK_PULLBACK_FRACTION, PEAK_PULLBACK_MIN_PEAK, SL_NEAR_PROGRESS, SL_CRITICAL_PROGRESS, TP_NEAR_PROGRESS } from "./trade-monitor-store.js";
import { getEaConnectionStatus, getLastKnownAccountSnapshot } from "@dave/ea-bridge";
import { getSkill, listSkills } from "@dave/skills";
import { loadFrozenSnapshot, FROZEN_PAIR_CHAR_BUDGET } from "@dave/memory";
import { knowledgeList } from "@dave/knowledge";
import { listReminders, formatReminderLine } from "@dave/workers";
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
  const deepLossPercent = getDeepLossAlertPercent(userId);
  const alertToggles = getAlertToggles(userId);
  const alertsOff = ALERT_CATEGORIES.filter((c) => alertToggles[c.id] === false).map((c) => c.id);
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
    ? `Account: balance ${account.balance} | equity ${account.equity} | margin ${account.margin} | free margin ${account.freeMargin}${account.leverage !== undefined ? ` | leverage 1:${account.leverage}` : " | leverage: not reported by the EA yet"}${account.algoTrading === false ? " | ⚠️ ALGO TRADING IS OFF in MT5 -- every order will be refused until it's on. Tell the trader: press Algo Trading in MT5 (or /mt5 -> Restart MT5 if it runs in Dave's container)." : ""}`
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
    // Same reasoning: the self-aware monitor's deep-loss alert level, settable via set_deep_loss_alert.
    `Deep-loss alert: at ${deepLossPercent}% of the way from entry to the stop (the self-aware monitor warns you here)`,
    `Self-aware alerts: ${alertsOff.length === 0 ? "all on" : `off: ${alertsOff.join(", ")}`} (toggle with set_self_aware_alert)`,
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

  // Real bug fixed (the trader, explicit: "fix the skill so it can recall skill -- implement
  // exactly how your skill works so it will know when to call it or pop up to the agent"). Skills
  // were surfaced the same broken way memory and knowledge were: the model only ever saw a skill
  // if it was already ACTIVE (the block above), so a skill the user installed but hasn't activated
  // was invisible -- Dave could not know it existed, let alone that it fit the situation in front
  // of him. That is the opposite of how a coding agent's own skills work: an agent is shown a
  // catalog of every available skill with a one-line "use when", every turn, and decides from that
  // catalog when one applies.
  //
  // This gives Dave the same: a per-turn index of ALL his skills (name + what each is for), so he
  // can recognise when a strategy skill fits and surface it. Same shape and cost as the knowledge
  // index -- name + description only, never the full content (the active one's content is already
  // injected above; the others are fetched with get_active_strategy_skill only when activated).
  // Deliberately does NOT change the standing rule that ACTIVATION is the user's call: awareness is
  // the fix here, not silent self-activation. The index tells Dave to OFFER a fitting skill, not to
  // switch to it on his own.
  const skillIndex = safeLoadSkillIndex(userId, activeSkillId);
  if (skillIndex) {
    lines.push(
      "",
      "<available_skills>",
      skillIndex,
      "</available_skills>",
      "",
      "These are the strategy skills you have available -- your own catalogue, loaded every turn so you always know what's there. When the setup or the user's request clearly fits one of these, say so and offer to activate it; never switch strategy on your own initiative, and never ask which to use out of the blue. Activating or clearing one is always the user's call (set_active_strategy_skill / clear_active_strategy_skill), made only when they tell you to.",
      "What you see above is names and one-line descriptions. `skill_view` reads any one of them in full -- reading is free and changes nothing about how you trade. Use it before you offer a skill, so you're describing what it actually says rather than guessing from its name, and whenever asked what one of your strategies does.",
    );
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

  // The trader, explicit: "the self aware is for the bot and also the user" -- the monitor's
  // warnings don't only push to the user, they're surfaced HERE so Dave itself is aware of them and
  // can act (move a stop to breakeven, close a stuck trade, hold its risk after a win streak). Same
  // per-turn injection pattern as settings/memory/knowledge, and it respects the very same on/off
  // switches: a category the user turned off appears to neither the user nor the bot.
  const selfAware = safeLoadSelfAware(userId, alertToggles);
  if (selfAware) {
    lines.push(
      "",
      "<self_aware>",
      selfAware,
      "</self_aware>",
      "",
      "This is your own live read on the open trades, loaded fresh this turn. Act on it: a trade up ~1R has already had its stop moved to breakeven for you; if one is stuck flat, consider freeing the capital; if a winner has given back a chunk of its peak or the market has gone to chop, re-check whether the original idea is still live rather than waiting it out; if you're on a win streak, hold your risk and criteria exactly -- do not oversize. These are the same warnings the user gets; a category the user switched off is not shown.",
    );
  }

  // Dave's reminders to himself (the trader: "the bot can remind itself of something"). Pending
  // ones so he never sets a duplicate and knows what is coming; fired ones so a reminder that went
  // off between turns actually reaches him, not just the chat.
  const reminders = safeLoadReminders(userId);
  if (reminders) {
    lines.push(
      "",
      "<reminders>",
      reminders,
      "</reminders>",
      "",
      "These are reminders you set for yourself, each with the reason you had. A FIRED one has already been sent to the trader -- act on it if it still applies (or tell them why it no longer does), then remove it with delete_reminder. Delete pending ones that no longer matter; do not set a duplicate of one already listed.",
    );
  }

  return lines.filter((l) => l !== "").join("\n");
}

/**
 * The per-turn self-aware read: every open trade's lifecycle state and any actionable note the
 * monitor has latched, plus a hot-hand line when the win streak warrants it. Fail-safe like the
 * other loaders -- a missing/corrupt store or a store read error costs the turn nothing. Notes for a
 * switched-off category are suppressed (the switch governs the bot's awareness too, not just the push).
 */
function safeLoadSelfAware(userId: string, toggles: ReturnType<typeof getAlertToggles>): string | undefined {
  try {
    const monitors = listOpenMonitors(userId);
    const rows: string[] = [];
    for (const m of monitors) {
      const head = `${m.symbol} ${m.direction.toUpperCase()} #${m.ticket}`;
      const pnl = m.lastPnl !== undefined ? ` P/L ${m.lastPnl > 0 ? "+" : ""}${m.lastPnl}` : "";
      const notes: string[] = [];
      if (m.alerts.breakeven && toggles.breakeven) notes.push("up ~1R — offer to move stop to breakeven");
      if (m.alerts.stuck && toggles.stuck) notes.push("stuck flat near breakeven — consider closing");
      if ((m.state === "deep_loss" || m.alerts.deepLoss) && toggles.deep_loss) notes.push("near its stop");
      // The profit-side checks, surfaced to Dave the same way the downside ones already are. The
      // peak/pullback and range notes are derived live (not latched) so the context always reflects
      // where the trade stands THIS turn, not where it stood when an alert last fired.
      if (m.bestPnl !== undefined && m.lastPnl !== undefined && m.bestPnl >= PEAK_PULLBACK_MIN_PEAK) {
        const givenBack = m.bestPnl - m.lastPnl;
        if (givenBack >= m.bestPnl * PEAK_PULLBACK_FRACTION && toggles.peak_pullback) {
          notes.push(`gave back ${givenBack.toFixed(2)} of a ${m.bestPnl.toFixed(2)} peak — is the idea done?`);
        }
      }
      if (toggles.range && isRanging(m, Date.now())) notes.push("ranging — the expected move hasn't developed");
      // Escalating proximity, derived live so the context always shows where the trade stands NOW.
      if (m.alerts.slCritical && toggles.sl_critical) notes.push(`${Math.round(SL_CRITICAL_PROGRESS * 100)}% of the way to its stop — act now or the stop decides`);
      else if (m.alerts.slNear && toggles.sl_near) notes.push(`${Math.round(SL_NEAR_PROGRESS * 100)}% of the way to its stop`);
      if (m.alerts.tpNear && toggles.tp_near) notes.push(`${Math.round(TP_NEAR_PROGRESS * 100)}% of the way to target — run it, take partial, or tighten?`);
      if (m.alerts.profitStable && toggles.profit_stable) notes.push("held profit a while — confirm the plan still holds");
      if (m.alerts.quickProfitCheck && toggles.quick_profit_check) notes.push("10+ min in profit — still heading for the target?");
      const note = notes.length ? ` — ${notes.join("; ")}` : "";
      rows.push(`- ${head} [${m.state}]${pnl}${note}`);
    }
    let streakLine = "";
    if (toggles.hot_hand) {
      const streak = getWinStreak(userId);
      if (streak >= HOT_HAND_MIN_STREAK) {
        streakLine = `Win streak: ${streak} in a row — hold your risk and entry criteria exactly, do NOT oversize or loosen rules.`;
      }
    }
    if (rows.length === 0 && !streakLine) return undefined;
    return [...rows, streakLine].filter(Boolean).join("\n");
  } catch (err) {
    console.error(`[live-context] could not load self-aware state for ${userId} -- continuing without it:`, err);
    return undefined;
  }
}

/**
 * The per-turn skill catalogue: every skill's name and what it's for, with the active one marked so
 * it isn't presented as something to "switch to". Fail-safe like the memory and knowledge loaders --
 * a missing or corrupt registry costs the turn nothing.
 */
function safeLoadSkillIndex(userId: string, activeSkillId: string | undefined): string | undefined {
  try {
    const skills = listSkills(userId);
    if (skills.length === 0) return undefined;
    return skills
      .map((s) => {
        const active = s.id === activeSkillId ? " [ACTIVE NOW]" : "";
        const useWhen = s.description?.trim() ? ` -- use when: ${s.description.trim()}` : "";
        return `- [${s.id}] ${s.name}${active}${useWhen}`;
      })
      .join("\n");
  } catch (err) {
    console.error(`[live-context] could not load skills for ${userId} -- continuing without it:`, err);
    return undefined;
  }
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
    if (sections.length === 0) return undefined;
    // Usage meter, ported from Hermes Agent's memory block. Without it the model has no idea it is
    // near the ceiling until a write is rejected -- it only ever sees the CONTENT, never how much
    // room is left. Seeing "84%" is what turns consolidation into something it does before it is
    // forced to, which is the whole point of a bounded, curated memory.
    const used = (snapshot.memory?.trim().length ?? 0) + (snapshot.user?.trim().length ?? 0);
    const pct = Math.round((used / FROZEN_PAIR_CHAR_BUDGET) * 100);
    const meter =
      `Memory usage: ${pct}% (${used}/${FROZEN_PAIR_CHAR_BUDGET} chars).` +
      (pct >= 80
        ? " You are near the ceiling -- consolidate with edit_memory (merge overlapping entries, drop stale ones) BEFORE you need the room, rather than waiting for a write to be refused."
        : "");
    return [...sections, meter].join("\n\n");
  } catch (err) {
    console.error(`[live-context] could not load memory for ${userId} -- continuing without it:`, err);
    return undefined;
  }
}

function safeLoadReminders(userId: string): string | undefined {
  try {
    const now = Date.now();
    const reminders = listReminders(userId, { includeFired: true }, now);
    if (reminders.length === 0) return undefined;
    return reminders.map((r) => formatReminderLine(r, now)).join("\n");
  } catch (err) {
    console.error(`[live-context] could not load reminders for ${userId} -- continuing without them:`, err);
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

/**
 * Real latency bug fixed (the trader: "responses are slow"), measured, not guessed. The live
 * context block is deliberately rebuilt fresh on EVERY turn and prepended to the user's message
 * (see this module's header) -- but that message is then PERSISTED into conversation history
 * (telegram-bot-server.ts -> saveConversationHistory) and re-sent, verbatim, on every single
 * subsequent turn until it falls out of the 60-message window. The block is small when nothing is
 * configured (measured: 663 chars), but it embeds the FULL body of the active strategy skill when
 * one is set -- measured at 30,172 chars for a real ~29KB skill. With ~30 user turns retained,
 * that is ~884 KB / ~226k tokens of STALE, duplicated context riding on every request: a real
 * 29KB skill is sent thirty times over, twenty-nine of those copies being old snapshots of
 * settings, clock and memory that are not just useless but actively misleading (a "NOW:" line
 * from two hours ago sitting in history as if it were current).
 *
 * These sentinels make the block a machine-strippable region so exactly ONE copy -- the fresh one
 * on the current turn -- ever reaches the model. Stripping happens on the way INTO storage (and
 * on the way back out, so a history already bloated on the live bot heals itself without the
 * owner having to /reset).
 */
export const LIVE_CONTEXT_OPEN = "<live_context>";
export const LIVE_CONTEXT_CLOSE = "</live_context>";

/**
 * Real gap fixed (the trader, asking for message tagging -- this turned out to be the bigger half
 * of it). `react_to_message`, `pin_message`, `unpin_message` and `delete_message` are all real,
 * registered, CORE tools, and every one of them takes a `messageId`. Nothing in any turn ever told
 * Dave what message ids existed. So all four were unreachable in practice: the model could either
 * not call them at all, or could only call them with a guessed number, which Telegram rejects.
 * Same "registered is not the same as reachable" class as run_script and the background checks,
 * except here the missing piece was an ID rather than a tool name.
 *
 * One line, on the turn it applies to, naming the real id of the message being answered.
 */
function incomingMessageBlock(messageId: number | undefined): string {
  if (messageId === undefined) return "";
  return (
    `\n<incoming_message id="${messageId}">\n` +
    `This turn is answering Telegram message ${messageId}. That is a real id you can act on: react to it ` +
    `(react_to_message), pin it (pin_message), or delete one of your own messages by its id. Your reply is ` +
    `already tagged to it automatically -- you do not need to do anything for that.\n` +
    `</incoming_message>`
  );
}

/** Prepends the live settings block to a real user turn -- text or content-block (image) shape. */
export function withLiveContext(userId: string, content: string | ContentBlock[], incomingMessageId?: number): string | ContentBlock[] {
  const block = `${LIVE_CONTEXT_OPEN}\n${buildLiveSettingsBlock(userId)}${incomingMessageBlock(incomingMessageId)}\n${LIVE_CONTEXT_CLOSE}`;
  if (typeof content === "string") return `${block}\n\n${content}`;
  return [{ type: "text", text: block }, ...content];
}

/**
 * Real, honest legacy handling: histories already written to disk by the deployed bot carry the
 * block WITHOUT the sentinels above, so a sentinel-only strip would leave every one of those
 * copies in place until they aged out one turn at a time. Every legacy block starts with
 * `<current_settings>` and ends with one of these exact, checked-in terminal fragments (see
 * buildLiveSettingsBlock -- the last section present wins, hence "the last one that matches").
 * Anchored to a `<current_settings>` prefix so this can never chew into genuine user text that
 * merely happens to quote one of these sentences.
 */
const LEGACY_BLOCK_TERMINATORS = [
  "never claim one isn't set when it's listed here.",
  "</active_strategy_skill>",
  "never claim you don't remember it.",
  "both calls, or nothing is committed).",
  // The available_skills catalogue can be the last block in the region (a user with skills but no
  // memory or knowledge yet), so its final line must be a recognised terminator or a legacy
  // history carrying it won't fully heal on load.
  //
  // NOTE FOR ANYONE EDITING THE SKILLS BLOCK: whenever its LAST line changes, the new final
  // sentence has to be added here, and the old one kept -- histories already on disk still end
  // with the old wording. step129's legacy-heal assertion is what catches a miss.
  "made only when they tell you to.",
  "and whenever asked what one of your strategies does.",
];

function stripLiveContextText(text: string): string {
  if (text.startsWith(LIVE_CONTEXT_OPEN)) {
    const end = text.indexOf(LIVE_CONTEXT_CLOSE);
    if (end !== -1) return text.slice(end + LIVE_CONTEXT_CLOSE.length).replace(/^\s+/, "");
  }
  if (text.startsWith("<current_settings>")) {
    let cut = -1;
    for (const marker of LEGACY_BLOCK_TERMINATORS) {
      const at = text.lastIndexOf(marker);
      if (at !== -1) cut = Math.max(cut, at + marker.length);
    }
    if (cut !== -1) return text.slice(cut).replace(/^\s+/, "");
  }
  return text;
}

/**
 * Removes the live-context region from a stored user message, leaving the person's real words.
 * Never throws and never alters content it does not recognize -- a message that was never wrapped
 * comes back byte-identical.
 */
export function stripLiveContext(content: string | ContentBlock[]): string | ContentBlock[] {
  if (typeof content === "string") return stripLiveContextText(content);
  if (!Array.isArray(content)) return content;
  return content
    .map((b) => (b && b.type === "text" && typeof b.text === "string" ? { ...b, text: stripLiveContextText(b.text) } : b))
    .filter((b) => !(b && b.type === "text" && b.text === ""));
}
