import type { DaveDatabase } from "@dave/db";
import type { DavemaClient } from "@dave/davema";
import { checkSandboxHealth } from "@dave/sandbox";
import {
  TelegramClient,
  parseCommand,
  eaPickerKeyboard,
  personalizeEaFile,
  settingsScreen,
  keyboard,
  coloredButton,
  approvalKeyboard,
  DAVE_COMMANDS,
  type DaveCommand,
  type TelegramCallbackQuery,
} from "@dave/telegram";
import { getLastKnownAccountSnapshot, getLastKnownState, getEaConnectionStatus } from "@dave/ea-bridge";
import {
  getRiskSettings,
  setRiskMode,
  getAutoApprovalEnabled,
  setAutoApprovalEnabled,
  listPendingLimitChanges,
  approveSettingsChange,
  declineSettingsChange,
  proposeProtectedLimitChange,
  setPendingLimitEntry,
  getPendingLimitEntry,
  type ProtectedLimitField,
  getTrailingStopConfig,
  setTrailingStopConfig,
  setPendingTrailingEntry,
  getPendingTrailingEntry,
  type TrailingField,
  getActiveGroupInfo,
  listGroups,
  setActiveGroup,
  setFallbackGroup,
  getTradingMode,
  setTradingMode,
  TradingSkillsModeRequiresSkillError,
  type RiskMode,
} from "@dave/trading";
import { listSkills } from "@dave/skills";
import {
  getVoiceSettings,
  setVoiceEnabled,
  setActiveProvider,
  setVoiceId,
  buildVoiceSettingsKeyboard,
  buildVoicePickerKeyboard,
  parseVoiceCallback,
  getTtsProviderKey,
  ElevenLabsClient,
  setPendingVoiceIdEntry,
  getPendingVoiceIdEntry,
  setPendingTtsKeyEntry,
  getPendingTtsKeyEntry,
  hasTtsProviderKey,
  setTtsProviderKey,
  getNotificationSettings,
  setPushEnabled,
  setEmailEnabled,
  setTradeOpenedEnabled,
} from "@dave/notifications";
import { getWriteApprovalSetting, setWriteApprovalSetting } from "@dave/memory";
import { addE2BKey, listE2BKeys, removeE2BKey, setPendingE2BKeyEntry, getPendingE2BKeyEntry } from "@dave/e2b";
import {
  getModelConfig,
  setModelConfig,
  listProviderCatalog,
  listProviderKeys,
  setPrimaryProviderKey,
  editProviderKey,
  getProviderKeyById,
  fetchAvailableModels,
  setPendingManualModelEntry,
  getPendingManualModelEntry,
  addProviderKeysBulk,
  setPendingKeyEntry,
  getPendingKeyEntry,
  type ProviderName,
  type StoredProviderKey,
} from "@dave/brain";
import { getReport as getCircuitBreakerReport, formatTripReport, getInterruptState } from "@dave/safety";
import { listWorkers } from "@dave/workers";
import { clearConversationHistory } from "./conversation-store.js";

/**
 * Real gap fixed (A2/A3): onUpdate had zero command router -- every
 * message, "/reset" included, fell through to the LLM conversationally,
 * and every callback_query (every inline button press) was silently
 * dropped. This module is that router: dispatchCommand() intercepts the
 * 9 real slash commands (commands.ts's DAVE_COMMANDS) BEFORE the agent
 * loop ever sees them, and dispatchCallback() gives every inline button
 * (settings toggles, approve/decline, provider switch, EA picker) a
 * real, live handler instead of a dead click.
 */

export interface CommandRouterDeps {
  db: DaveDatabase;
  client: TelegramClient;
  userId: string; // the one Dave account these commands operate on
  publicBaseUrl: string;
  /** Optional -- only needed for /connection's real DAVEMA ping. Every other command works fine without it. */
  davema?: DavemaClient;
}

function formatMoney(n: number | undefined): string {
  return typeof n === "number" ? `$${n.toFixed(2)}` : "n/a";
}

async function handleAccount(deps: CommandRouterDeps, chatId: number): Promise<void> {
  const snapshot = getLastKnownAccountSnapshot(deps.userId);
  if (!snapshot) {
    await deps.client.sendMessage({ chat_id: chatId, text: "No EA report yet -- connect your MT5 EA first (see /ea)." });
    return;
  }
  const eaStatus = getEaConnectionStatus(deps.userId);
  const text =
    `<b>Account</b>\n` +
    `Account: ${snapshot.account}\n` +
    `Balance: ${formatMoney(snapshot.balance)}\n` +
    `Equity: ${formatMoney(snapshot.equity)}\n` +
    `Margin: ${formatMoney(snapshot.margin)}\n` +
    `Free margin: ${formatMoney(snapshot.freeMargin)}\n` +
    `EA connection: ${eaStatus.connected ? "🟢 connected" : `🔴 disconnected${eaStatus.secondsSinceLastSeen !== null ? ` (last seen ${eaStatus.secondsSinceLastSeen}s ago)` : " (never connected)"}`}`;
  await deps.client.sendMessage({ chat_id: chatId, text, parse_mode: "HTML" });
}

/** Real fix (spec: per-service 🟢/🔴/🟡 status): the EA/MT5 bridge's real connection state
 * (getEaConnectionStatus, backed by the real lastSeen heartbeat every EA report already writes)
 * is now honestly shown here instead of just raw position counts with no connectivity signal. */
/** Real fix (spec: "status button per service... DAVEMA, the AI provider/brain, MT5/EA
 * bridge, the sandbox, the database") -- this used to only ever show EA/position counts, with
 * zero real signal on the other 4 real subsystems. Each check below calls the actual real
 * function that subsystem's own health-check already uses elsewhere (DavemaClient.ping(),
 * checkSandboxHealth(), getEaConnectionStatus()) rather than inventing a second, parallel
 * check that could drift from what's actually true. */
async function handleConnection(deps: CommandRouterDeps, chatId: number): Promise<void> {
  const state = getLastKnownState(deps.userId);
  const eaStatus = getEaConnectionStatus(deps.userId);
  const eaLine = eaStatus.connected
    ? "🟢 MT5/EA bridge: connected"
    : `🔴 MT5/EA bridge: ${eaStatus.lastSeenAt === null ? "never connected" : `disconnected (last seen ${eaStatus.secondsSinceLastSeen}s ago)`}`;

  let davemaLine: string;
  if (!deps.davema) {
    davemaLine = "🟡 DAVEMA: not checkable in this context";
  } else {
    try {
      await deps.davema.ping();
      davemaLine = "🟢 DAVEMA: connected";
    } catch (err) {
      davemaLine = `🔴 DAVEMA: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const config = getModelConfig(deps.userId);
  const configuredProviders = new Set(listProviderKeys(deps.db, deps.userId).map((k) => k.provider));
  const brainReady = config.primary === "airllm" || configuredProviders.has(config.primary);
  const brainLine = brainReady ? `🟢 AI provider/brain: ${config.primary}` : `🔴 AI provider/brain: ${config.primary} (no working key)`;

  let sandboxLine: string;
  try {
    const sandboxHealth = await checkSandboxHealth(process.cwd());
    sandboxLine = sandboxHealth.reachable ? `🟢 Sandbox: ${sandboxHealth.detail}` : `🟡 Sandbox: degraded (${sandboxHealth.detail})`;
  } catch (err) {
    sandboxLine = `🔴 Sandbox: ${err instanceof Error ? err.message : String(err)}`;
  }

  let dbLine: string;
  try {
    const tables = deps.db.listTables();
    dbLine = `🟢 Database: connected (${tables.length} table(s))`;
  } catch (err) {
    dbLine = `🔴 Database: ${err instanceof Error ? err.message : String(err)}`;
  }

  const text =
    `<b>Connection</b>\n${davemaLine}\n${brainLine}\n${eaLine}\n${sandboxLine}\n${dbLine}\n\n` +
    `Open positions: ${state.positions.length}\nPending orders: ${state.pendingOrders.length}`;
  await deps.client.sendMessage({ chat_id: chatId, text, parse_mode: "HTML" });
}

/** Real fix (user report: "providers is missing? it's only airllm and deepseek and Claude") --
 * this used to hardcode 3 providers even after the catalog grew to all 28+AirLLM. Now it lists
 * every catalog entry, per-provider marking whether the user has a configured key (AirLLM excepted --
 * it's self-hosted via AIRLLM_BASE_URL, no key needed) so picking one that isn't ready yet is an
 * informed choice, not a silent dead end. Tapping a provider opens its detail screen (real stored
 * keys, tap-to-activate) rather than blindly setting it primary. */
function providersKeyboard(current: ProviderName, configuredProviders: Set<ProviderName>): ReturnType<typeof keyboard> {
  const catalog = listProviderCatalog().filter((e) => e.id !== "custom");
  const rows: ReturnType<typeof coloredButton>[][] = [];
  for (let i = 0; i < catalog.length; i += 2) {
    const pair = catalog.slice(i, i + 2);
    rows.push(
      pair.map((entry) => {
        const ready = entry.id === "airllm" || configuredProviders.has(entry.id);
        const isCurrent = current === entry.id;
        const label = `${isCurrent ? "✅ " : ""}${entry.id}${ready ? "" : " (no key)"}`;
        return coloredButton(label, isCurrent ? "green" : ready ? "neutral" : "red", `provider:${entry.id}`);
      })
    );
  }
  return keyboard(rows);
}

/** Real fix (user: "when providers is not set it to say provider not set") -- Primary previously
 * always printed getModelConfig's stored/default provider name as if it were a working, ready
 * choice, even on a totally fresh install where it's just DEFAULT_CONFIG's fallback ("airllm")
 * with zero real keys behind it. Now explicitly says "(not set -- no working key)" when the
 * primary provider isn't actually ready (airllm excepted: self-hosted, no key required). */
async function handleProviders(deps: CommandRouterDeps, chatId: number): Promise<void> {
  const config = getModelConfig(deps.userId);
  const configuredProviders = new Set(listProviderKeys(deps.db, deps.userId).map((k) => k.provider));
  const catalogCount = listProviderCatalog().filter((e) => e.id !== "custom").length;
  const primaryReady = config.primary === "airllm" || configuredProviders.has(config.primary);
  const primaryLine = primaryReady ? config.primary : `${config.primary} (not set -- no working key)`;
  const text =
    `<b>AI Provider</b>\nPrimary: ${primaryLine}\nFallback: ${config.fallback.join(", ") || "none"}\n\n` +
    `${catalogCount} providers available. Tap a provider to see its keys:`;
  await deps.client.sendMessage({ chat_id: chatId, text, parse_mode: "HTML", reply_markup: providersKeyboard(config.primary, configuredProviders) });
}

/** Real fix (spec: "Tap a provider -> shows its stored keys (up to 10 per provider) each with
 * health status, tap a key to activate"). Renders the provider detail screen sent both from
 * /providers' provider: callback and re-rendered in place after activating a key. */
function providerDetailView(deps: CommandRouterDeps, provider: ProviderName): { text: string; reply_markup: ReturnType<typeof keyboard> } {
  const entry = listProviderCatalog().find((e) => e.id === provider)!;
  const keys = listProviderKeys(deps.db, deps.userId, provider);
  const config = getModelConfig(deps.userId);
  const lines = [`<b>${entry.displayName}</b>`, entry.notes, ""];
  if (provider === "airllm") {
    lines.push("Self-hosted via AIRLLM_BASE_URL -- no stored key needed.");
  } else if (keys.length === 0) {
    lines.push("No keys stored yet -- add one below, or in the admin panel's Provider Keys tab.");
  } else {
    lines.push(`${keys.length}/10 stored key(s):`);
  }
  const rows: ReturnType<typeof coloredButton>[][] = [];
  for (const key of keys) {
    const health = key.healthy ? "🟢" : "🔴";
    const star = key.isPrimary ? "⭐ " : "";
    rows.push([coloredButton(`${star}${health} ${key.label}`, key.isPrimary ? "green" : "neutral", `activatekey:${key.id}`)]);
  }
  if (provider !== "airllm" && provider !== "custom" && keys.length < 10) {
    rows.push([coloredButton("➕ Add key(s)", "blue", `addkey:${provider}`)]);
  }
  rows.push([coloredButton(config.primary === provider ? "✅ Primary provider" : "Set as primary provider", config.primary === provider ? "green" : "blue", `setprimaryprovider:${provider}`)]);
  rows.push([{ text: "⬅️ Back", callback_data: "providers:back" }]);
  return { text: lines.join("\n"), reply_markup: keyboard(rows) };
}

/** Real fix (user: "It should fetch the models like v1 model so I can select as well") --
 * live-fetches the active provider's real model list and lets the user pick one via buttons,
 * instead of just printing a static default. OpenRouter/OrcaRouter/HuggingFace stay manual-entry
 * (per the master spec), captured via the next free-text message (see tryHandlePendingModelEntry). */
const fetchedModelsCache = new Map<string, { provider: ProviderName; models: string[] }>();

function primaryKeyFor(deps: CommandRouterDeps, provider: ProviderName): StoredProviderKey | undefined {
  const keys = listProviderKeys(deps.db, deps.userId, provider);
  return keys.find((k) => k.isPrimary) ?? keys[0];
}

/** Real fix (user: "the model should be fetched not hardcoded and default") -- this used to show
 * the catalog's hardcoded `defaultModel` as "Current" the moment a key existed, even if the user
 * had never actually picked a model -- indistinguishable from a real, deliberate choice. Now only
 * a model the user (or a previous live fetch) actually SET is ever shown as current; otherwise it
 * honestly says "not set" and pushes the user toward the real live-fetch picker below, rather than
 * quietly relying on the hardcoded default. */
async function handleModels(deps: CommandRouterDeps, chatId: number): Promise<void> {
  const config = getModelConfig(deps.userId);
  const provider = config.primary;
  const entry = listProviderCatalog().find((e) => e.id === provider)!;

  // AirLLM is fixed, self-hosted infrastructure (Qwen3-235B via AIRLLM_BASE_URL) -- there is no
  // per-key model to pick and no real /models endpoint to fetch (modelsPath is null), so it gets
  // its own honest, static answer instead of a broken empty fetch/manual-entry flow.
  if (provider === "airllm") {
    await deps.client.sendMessage({ chat_id: chatId, text: `<b>Model for airllm</b>\nFixed: <code>${entry.defaultModel}</code> (self-hosted via AIRLLM_BASE_URL -- not user-selectable).`, parse_mode: "HTML" });
    return;
  }

  const key = primaryKeyFor(deps, provider);
  if (!key) {
    await deps.client.sendMessage({ chat_id: chatId, text: `Provider not set: <b>${provider}</b> has no working key -- add one in the admin panel, or /providers to switch.`, parse_mode: "HTML" });
    return;
  }
  const chosenModel = key.config.model;
  const currentLine = chosenModel ? `Current: <code>${chosenModel}</code>` : `Model not set yet -- will use ${provider}'s own default (<code>${entry.defaultModel}</code>) until you pick one.`;

  if (entry.manualModelEntry) {
    setPendingManualModelEntry(deps.db, deps.userId, provider);
    await deps.client.sendMessage({
      chat_id: chatId,
      text: `<b>Model for ${provider}</b>\n${currentLine}\n\n${provider} requires manual model entry -- reply with the exact model ID as your next message and I'll set it.`,
      parse_mode: "HTML",
    });
    return;
  }
  await deps.client.sendMessage({
    chat_id: chatId,
    text: `<b>Model for ${provider}</b>\n${currentLine}\n\nTap below to fetch the live model list from ${provider}'s real API and pick one.`,
    parse_mode: "HTML",
    reply_markup: keyboard([[coloredButton("🔄 Fetch live models", "blue", `fetchmodels:${provider}`)]]),
  });
}

/** Best-effort: the user's next free-text message after /models on a manual-entry provider IS
 * the model ID. Returns true if it consumed the message (caller must not also forward it to the LLM). */
export async function tryHandlePendingModelEntry(deps: CommandRouterDeps, chatId: number, text: string): Promise<boolean> {
  const provider = getPendingManualModelEntry(deps.db, deps.userId);
  if (!provider) return false;
  setPendingManualModelEntry(deps.db, deps.userId, null);
  const key = primaryKeyFor(deps, provider);
  if (!key) {
    await deps.client.sendMessage({ chat_id: chatId, text: `No key configured for <b>${provider}</b> -- add one in the admin panel first.`, parse_mode: "HTML" });
    return true;
  }
  editProviderKey(deps.db, deps.userId, key.id, { config: { model: text.trim() } });
  await deps.client.sendMessage({ chat_id: chatId, text: `Model for <b>${provider}</b> set to <code>${text.trim()}</code>.`, parse_mode: "HTML" });
  return true;
}

/** Fish Audio has no listable-voices endpoint -- same next-message-IS-the-value capture as manual model entry. */
export async function tryHandlePendingVoiceEntry(deps: CommandRouterDeps, chatId: number, text: string): Promise<boolean> {
  const provider = getPendingVoiceIdEntry(deps.db, deps.userId);
  if (!provider) return false;
  setPendingVoiceIdEntry(deps.db, deps.userId, null);
  setVoiceId(deps.db, deps.userId, provider, text.trim());
  await deps.client.sendMessage({ chat_id: chatId, text: `Voice for <b>${provider}</b> set to <code>${text.trim()}</code>.`, parse_mode: "HTML" });
  return true;
}

/** Real fix (user: "elevenlabs... should be settable in the telegram") -- sets the TTS
 * provider's own API key from a real Telegram message, previously admin-panel-only. */
export async function tryHandlePendingTtsKeyEntry(deps: CommandRouterDeps, chatId: number, text: string): Promise<boolean> {
  const provider = getPendingTtsKeyEntry(deps.db, deps.userId);
  if (!provider) return false;
  setPendingTtsKeyEntry(deps.db, deps.userId, null);
  setTtsProviderKey(deps.db, deps.userId, provider, text.trim());
  await deps.client.sendMessage({ chat_id: chatId, text: `✅ ${provider} API key saved.` });
  return true;
}

/** Real fix (user: "e2b... should be settable in the telegram") -- E2B keys previously only
 * had an admin-panel route. */
export async function tryHandlePendingE2BKeyEntry(deps: CommandRouterDeps, chatId: number, text: string): Promise<boolean> {
  if (!getPendingE2BKeyEntry(deps.db, deps.userId)) return false;
  setPendingE2BKeyEntry(deps.db, deps.userId, false);
  const key = addE2BKey(deps.db, deps.userId, `E2B ${listE2BKeys(deps.db, deps.userId).length}`, text.trim());
  await deps.client.sendMessage({ chat_id: chatId, text: `✅ E2B key saved (${key.label}).` });
  return true;
}

/** Real fix (user: "I can set up to 10 keys in the telegram and paste the settable
 * credentials in telegram") -- the user's next message is one or more API keys, one per
 * line (a single pasted key is just a 1-line case of the same real bulk-add path, which
 * already enforces the 10-key cap and reports per-line success/failure honestly). */
export async function tryHandlePendingKeyEntry(deps: CommandRouterDeps, chatId: number, text: string): Promise<boolean> {
  const provider = getPendingKeyEntry(deps.db, deps.userId);
  if (!provider) return false;
  setPendingKeyEntry(deps.db, deps.userId, null);
  const results = addProviderKeysBulk(deps.db, deps.userId, provider, provider, text);
  const lines = results.map((r, i) => (r.ok ? `Line ${i + 1}: OK (${r.key!.label})` : `Line ${i + 1}: FAILED -- ${r.error}`));
  await deps.client.sendMessage({
    chat_id: chatId,
    text: `<b>Adding key(s) for ${provider}</b>\n${lines.join("\n")}`,
    parse_mode: "HTML",
  });
  return true;
}

function modeLabel(mode: RiskMode, value?: number): string {
  if (mode === "on") return `On (${value})`;
  return mode === "auto" ? "Auto" : "Off";
}

/** Real fix (spec: "/settings holds SETTINGS ONLY", broken into real sections instead of one flat
 * screen -- RISK/TRADING, TRADING MODE, PAIR GROUP, VOICE, MEMORY. Update Brief/Notifications/
 * Security-Schedule/Trailing-breakeven-TP1-3/protected-limit-change UI are real, tracked gaps, not
 * built into this screen yet -- see the audit report for what's pending. */
function settingsTopKeyboard(): ReturnType<typeof keyboard> {
  return keyboard([
    [coloredButton("Risk / Trading", "blue", "settings:risk"), coloredButton("Trading Mode", "blue", "settings:tradingmode")],
    [coloredButton("Pair Group", "blue", "settings:pairgroup"), coloredButton("Voice", "blue", "settings:voice")],
    [coloredButton("Memory", "blue", "settings:memory"), coloredButton("E2B Keys", "blue", "settings:e2b")],
    [coloredButton("Trailing / Breakeven", "blue", "settings:trailing"), coloredButton("Notifications", "blue", "settings:notifications")],
  ]);
}

/** NOTIFICATIONS section: real push toggle (genuinely gates the alert-sending tools in
 * extra-tools.ts), real trade-opened toggle, and an honestly-labeled email toggle -- the
 * setting is real and stored, but no email-sending capability exists anywhere in this
 * codebase yet, so it's flagged rather than pretended to work. */
function notificationsKeyboard(deps: CommandRouterDeps): ReturnType<typeof keyboard> {
  const settings = getNotificationSettings(deps.db, deps.userId);
  return keyboard([
    [coloredButton(`Push notifications: ${settings.pushEnabled ? "On" : "Off"}`, settings.pushEnabled ? "green" : "red", "notif:togglepush")],
    [coloredButton(`Trade-opened alert: ${settings.tradeOpenedEnabled ? "On" : "Off"}`, settings.tradeOpenedEnabled ? "green" : "red", "notif:toggletradeopened")],
    [coloredButton(`Email notifications: ${settings.emailEnabled ? "On (no email sender configured yet)" : "Off"}`, settings.emailEnabled ? "green" : "red", "notif:toggleemail")],
    [{ text: "⬅️ Back", callback_data: "settings:top" }],
  ]);
}

/** Real fix (spec: "Trailing/breakeven... TP1/TP2/TP3 trigger values") -- the real backend
 * (trailing-config.ts) already existed, but nothing let the user set these 3 values from
 * Telegram. Honestly labeled per the real config shape (an SL lock-in level for each TP
 * stage, not a separate "trigger price" concept -- see breakeven-trailing.ts). Note: there is
 * deliberately no global on/off toggle here -- breakeven/trailing is opt-in PER POSITION,
 * decided by Dave at trade time (a real, explicit fix from earlier in this build: "a normal
 * trade should NOT get this by default"), not a blanket account-wide switch that would
 * contradict that design. */
function trailingKeyboard(userId: string): { text: string; reply_markup: ReturnType<typeof keyboard> } {
  const config = getTrailingStopConfig(userId);
  const lines = [
    "<b>Trailing / Breakeven</b>",
    "SL lock-in level Dave moves to at each TP stage (opt-in per position, not automatic on every trade):",
  ];
  const rows: ReturnType<typeof coloredButton>[][] = [
    [{ text: config ? `TP1 -> SL ${config.slAtTp1} (tap to change)` : "Set TP1 SL level", callback_data: "trailing:slAtTp1" }],
    [{ text: config ? `TP2 -> SL ${config.slAtTp2} (tap to change)` : "Set TP2 SL level", callback_data: "trailing:slAtTp2" }],
    [{ text: config ? `TP3 -> SL ${config.slAtTp3} (tap to change)` : "Set TP3 SL level", callback_data: "trailing:slAtTp3" }],
    [{ text: "⬅️ Back", callback_data: "settings:top" }],
  ];
  return { text: lines.join("\n"), reply_markup: keyboard(rows) };
}

export async function tryHandlePendingTrailingEntry(deps: CommandRouterDeps, chatId: number, text: string): Promise<boolean> {
  const field = getPendingTrailingEntry(deps.userId);
  if (!field) return false;
  setPendingTrailingEntry(deps.userId, null);
  const value = Number(text.trim());
  if (!Number.isFinite(value)) {
    await deps.client.sendMessage({ chat_id: chatId, text: `That doesn't look like a real price level -- reply with just the number. Tap the row in /settings to try again.` });
    return true;
  }
  const existing = getTrailingStopConfig(deps.userId) ?? { slAtTp1: 0, slAtTp2: 0, slAtTp3: 0 };
  const updated = { ...existing, [field]: value };
  setTrailingStopConfig(deps.userId, updated);
  await deps.client.sendMessage({ chat_id: chatId, text: `✅ ${field} set to ${value}` });
  return true;
}

/** Real fix (user: "e2b... should be settable in the telegram") -- same real backend
 * (e2b-keys.ts) the admin panel already used, now reachable from /settings too. */
function e2bKeyboard(deps: CommandRouterDeps): { text: string; reply_markup: ReturnType<typeof keyboard> } {
  const keys = listE2BKeys(deps.db, deps.userId);
  const lines = [`<b>E2B Keys</b>`, keys.length === 0 ? "No keys stored yet." : `${keys.length}/10 stored key(s):`];
  const rows: ReturnType<typeof coloredButton>[][] = keys.map((k) => [
    coloredButton(`${k.healthy ? "🟢" : "🔴"} ${k.label}`, "neutral", `e2bkey:noop:${k.id}`),
    coloredButton("Remove", "red", `e2bkey:remove:${k.id}`),
  ]);
  if (keys.length < 10) rows.push([coloredButton("➕ Add key", "blue", "e2bkey:add")]);
  rows.push([{ text: "⬅️ Back", callback_data: "settings:top" }]);
  return { text: lines.join("\n"), reply_markup: keyboard(rows) };
}

async function handleSettings(deps: CommandRouterDeps, chatId: number): Promise<void> {
  await deps.client.sendMessage({ chat_id: chatId, text: "<b>Settings</b>\nTrading-rule content (what/when/how to trade) lives in your uploaded rules file, never here.", parse_mode: "HTML", reply_markup: settingsTopKeyboard() });
}

function riskSettingsKeyboard(userId: string) {
  const settings = getRiskSettings(userId);
  const pendingChanges = listPendingLimitChanges(userId);
  const pendingFor = (field: ProtectedLimitField) => pendingChanges.find((c) => c.field === field);
  const maxOpenTradesLabel = pendingFor("maxOpenTrades")
    ? `Max open trades: ${settings.maxOpenTrades ?? "not set"} (pending approval)`
    : `Max open trades: ${settings.maxOpenTrades ?? "not set"} (tap to change)`;
  const maxDailyLossLabel = pendingFor("maxDailyLossPct")
    ? `Max daily loss: ${settings.maxDailyLossPct ?? "not set"}% (pending approval)`
    : `Max daily loss: ${settings.maxDailyLossPct ?? "not set"}% (tap to change)`;
  return settingsScreen(
    [
      [
        { label: `SL: ${modeLabel(settings.slMode, settings.slValue)}`, callbackData: "cyclemode:sl", active: false },
        { label: `TP: ${modeLabel(settings.tpMode, settings.tpValue)}`, callbackData: "cyclemode:tp", active: false },
      ],
      [{ label: `Lot: ${modeLabel(settings.lotMode, settings.lotValue)}`, callbackData: "cyclemode:lot", active: false }],
      // Real fix: max open trades / max daily loss are PROTECTED (SECURITY.md) -- tapping
      // never applies a value directly, it only primes capture of the user's own number,
      // which then goes through the real, unavoidable proposeProtectedLimitChange ->
      // separate approve/decline round trip, same as a Dave-initiated proposal.
      [{ label: maxOpenTradesLabel, callbackData: "proposelimit:maxOpenTrades", active: false }],
      [{ label: maxDailyLossLabel, callbackData: "proposelimit:maxDailyLossPct", active: false }],
    ],
    "settings:top"
  );
}

/** The user's next message after tapping a protected-limit row IS the proposed new number --
 * this only ever calls proposeProtectedLimitChange(), which (per SECURITY.md, enforced in
 * risk-settings.ts, not just documented) can NEVER apply directly -- it always queues a
 * separate, real approve/decline round trip via the same colored-button flow every other
 * settings-change approval uses. */
export async function tryHandlePendingLimitEntry(deps: CommandRouterDeps, chatId: number, text: string): Promise<boolean> {
  const field = getPendingLimitEntry(deps.userId);
  if (!field) return false;
  setPendingLimitEntry(deps.userId, null);
  const value = Number(text.trim());
  if (!Number.isFinite(value) || value <= 0) {
    await deps.client.sendMessage({ chat_id: chatId, text: `That doesn't look like a real number -- reply with just the value, e.g. "5" or "3.5". Tap the row in /settings to try again.` });
    return true;
  }
  const reasonText = field === "maxOpenTrades" ? `User requested max open trades = ${value} via Telegram.` : `User requested max daily loss = ${value}% via Telegram.`;
  const change = proposeProtectedLimitChange(deps.userId, field, value, reasonText);
  const label = field === "maxOpenTrades" ? `Max open trades -> ${value}` : `Max daily loss -> ${value}%`;
  await deps.client.sendMessage({
    chat_id: chatId,
    text: `<b>Approval needed</b>\n${label}\n\nThis is a protected limit -- it never applies without your explicit yes.`,
    parse_mode: "HTML",
    reply_markup: listPendingApprovalsKeyboard(change.id),
  });
  return true;
}

/** TRADING MODE section: Auto (own judgment + skill library) vs Trading Skills (locked to one taught skill). */
function tradingModeKeyboard(userId: string): ReturnType<typeof keyboard> {
  const state = getTradingMode(userId);
  return keyboard([
    [coloredButton(state.mode === "auto" ? "✅ Auto" : "Auto", state.mode === "auto" ? "green" : "neutral", "tradingmode:auto")],
    [coloredButton(state.mode === "trading-skills" ? `✅ Trading Skills (${state.lockedSkillId ?? "none"})` : "Trading Skills", state.mode === "trading-skills" ? "green" : "neutral", "tradingmode:pickskill")],
    [{ text: "⬅️ Back", callback_data: "settings:top" }],
  ]);
}

function skillPickerKeyboard(userId: string): ReturnType<typeof keyboard> {
  const skills = listSkills(userId);
  const rows: ReturnType<typeof coloredButton>[][] = skills.map((s) => [coloredButton(s.name, "neutral", `tradingmode:setskill:${s.id}`)]);
  rows.push([{ text: "⬅️ Back", callback_data: "settings:tradingmode" }]);
  return keyboard(rows);
}

/** PAIR GROUP section: exactly one active + one fallback at a time, per pair-groups.ts's own real invariant. */
function pairGroupKeyboard(userId: string): { text: string; reply_markup: ReturnType<typeof keyboard> } {
  const groups = listGroups(userId);
  const info = getActiveGroupInfo(userId);
  const lines = [
    `<b>Pair Group</b>`,
    `Active: ${info.activeGroup?.name ?? "none"}`,
    `Fallback: ${info.fallbackGroup?.name ?? "none"}`,
    info.pausedForExtremeConditions ? "⚠️ Paused for extreme market conditions." : "",
    "",
    groups.length === 0 ? "No pair groups defined yet -- create one in the admin panel." : "Tap to set active/fallback:",
  ].filter(Boolean);
  const rows: ReturnType<typeof coloredButton>[][] = groups.map((g) => [
    coloredButton(g.id === info.activeGroup?.id ? `✅ ${g.name}` : g.name, g.id === info.activeGroup?.id ? "green" : "neutral", `pairgroup:active:${g.id}`),
    coloredButton(g.id === info.fallbackGroup?.id ? `✅ Fallback` : "Set fallback", g.id === info.fallbackGroup?.id ? "green" : "neutral", `pairgroup:fallback:${g.id}`),
  ]);
  rows.push([{ text: "⬅️ Back", callback_data: "settings:top" }]);
  return { text: lines.join("\n"), reply_markup: keyboard(rows) };
}

/** VOICE section: on/off, TTS provider, per-provider voice ID (ElevenLabs: real live-fetched picker; Fish Audio: no listable-voices endpoint, captured via the next free-text message). */
const fetchedVoicesCache = new Map<string, { voiceId: string; name: string }[]>();

function voiceSettingsView(deps: CommandRouterDeps): { text: string; reply_markup: ReturnType<typeof keyboard> } {
  const settings = getVoiceSettings(deps.db, deps.userId);
  const baseKeyboard = buildVoiceSettingsKeyboard(settings);
  const rows = [...baseKeyboard.inline_keyboard];
  if (settings.enabled) {
    // Real gap fixed (user: "elevenlabs... should be settable in the telegram") -- this only
    // ever let you pick a voice/provider, never actually SET the provider's own API key
    // (admin-panel-only before this). Shown first since a voice/model pick is meaningless
    // without a real key behind it.
    const hasKey = hasTtsProviderKey(deps.db, deps.userId, settings.activeProvider);
    rows.push([{ text: hasKey ? `${settings.activeProvider} key: set (tap to change)` : `🔑 Set ${settings.activeProvider} API key`, callback_data: `voice:setkey:${settings.activeProvider}` }]);
    if (settings.activeProvider === "fish-audio") {
      rows.push([{ text: settings.fishVoiceId ? `Fish voice: ${settings.fishVoiceId} (tap to change)` : "Set Fish Audio voice ID", callback_data: "voice:manualvoice:fish-audio" }]);
    } else {
      rows.push([{ text: settings.elevenlabsVoiceId ? `ElevenLabs voice: ${settings.elevenlabsVoiceId} (tap to change)` : "🔄 Fetch live ElevenLabs voices", callback_data: "voice:fetchvoices:elevenlabs" }]);
    }
  }
  rows.push([{ text: "⬅️ Back", callback_data: "settings:top" }]);
  const text = `<b>Voice</b>\n${settings.enabled ? `On -- ${settings.activeProvider}` : "Off"}`;
  return { text, reply_markup: keyboard(rows) };
}

/** MEMORY section: write-approval (off by default -- Dave asks before saving to memory) + the
 * existing Dave-initiated-settings-change auto-approval switch, relocated here per the spec's
 * section naming (same single underlying control -- see the audit report). */
function memoryKeyboard(userId: string): ReturnType<typeof keyboard> {
  const writeApproval = getWriteApprovalSetting(userId);
  const autoApproval = getAutoApprovalEnabled(userId);
  return keyboard([
    [coloredButton(`Ask before saving to memory: ${writeApproval ? "On" : "Off"}`, writeApproval ? "green" : "red", "togglewriteapproval")],
    [coloredButton(`Auto-approve Dave's proposals: ${autoApproval ? "On" : "Off"}`, autoApproval ? "green" : "red", "toggleautoapproval")],
    [{ text: "⬅️ Back", callback_data: "settings:top" }],
  ]);
}

async function handleReset(deps: CommandRouterDeps, chatId: number, historyKey: string): Promise<void> {
  clearConversationHistory(deps.db, historyKey);
  await deps.client.sendMessage({ chat_id: chatId, text: "Conversation history cleared -- starting fresh." });
}

/** Real fix (spec: "3-4 real examples" of conversational use + mention /stop and /panic).
 * /stop and /panic are deliberately NOT in DAVE_COMMANDS (they're not part of the public
 * 9/10-command menu) -- real, working emergency commands, just not menu-listed; mentioned
 * here explicitly instead. */
async function handleHelp(deps: CommandRouterDeps, chatId: number): Promise<void> {
  const lines = DAVE_COMMANDS.map((c) => `/${c.command} -- ${c.description}`);
  const text =
    `<b>What I can do</b>\n${lines.join("\n")}\n\n` +
    `Everything else is just talking to me normally -- for example:\n` +
    `• "Set SL to 20 pips"\n` +
    `• "Switch to the Forex pair group"\n` +
    `• "Find me a setup on gold"\n` +
    `• "Switch provider to DeepSeek"\n\n` +
    `/stop or /panic halts all trading and workers instantly, any time -- not just a settings toggle.`;
  await deps.client.sendMessage({ chat_id: chatId, text, parse_mode: "HTML" });
}

async function handleStatus(deps: CommandRouterDeps, chatId: number): Promise<void> {
  const breaker = getCircuitBreakerReport(deps.db, deps.userId);
  const interrupt = getInterruptState(deps.userId);
  const workers = listWorkers(deps.userId);
  const breakerLine = breaker.tripped ? formatTripReport(breaker) : `OK (${breaker.consecutiveErrors} consecutive errors)`;
  const text =
    `<b>Status</b>\n` +
    `Circuit breaker: ${breakerLine}\n` +
    `Trading loop: ${interrupt.tradingLoop}\n` +
    `Active workers: ${workers.length}`;
  await deps.client.sendMessage({ chat_id: chatId, text, parse_mode: "HTML" });
}

async function handleEa(deps: CommandRouterDeps, chatId: number): Promise<void> {
  await deps.client.sendMessage({ chat_id: chatId, text: "Which MT5 account is this EA for?", reply_markup: eaPickerKeyboard() });
}

/** Real command dispatch. Returns true if `text` was a recognized command and was handled (caller should NOT also forward it to the LLM). */
/** Real fix (user: "/menu should be UI, not a list of commands") -- a real inline-keyboard
 * menu, same visual pattern as every other screen in this build (2 per row, Back row). Tapping
 * a button runs the EXACT SAME handler typing that command would -- this is the single real
 * dispatch point both dispatchCommand (text) and the menu: callback (button tap) share, so
 * there is no second, divergent code path for "the same command run two ways." */
async function dispatchCommandByName(deps: CommandRouterDeps, chatId: number, historyKey: string, command: DaveCommand): Promise<void> {
  switch (command) {
    case "account":
      await handleAccount(deps, chatId);
      break;
    case "connection":
      await handleConnection(deps, chatId);
      break;
    case "providers":
      await handleProviders(deps, chatId);
      break;
    case "models":
      await handleModels(deps, chatId);
      break;
    case "settings":
      await handleSettings(deps, chatId);
      break;
    case "reset":
      await handleReset(deps, chatId, historyKey);
      break;
    case "help":
      await handleHelp(deps, chatId);
      break;
    case "menu":
      await handleMenu(deps, chatId);
      break;
    case "status":
      await handleStatus(deps, chatId);
      break;
    case "ea":
      await handleEa(deps, chatId);
      break;
  }
}

const MENU_BUTTONS: { command: DaveCommand; label: string }[] = [
  { command: "account", label: "💰 Account" },
  { command: "connection", label: "🔌 Connection" },
  { command: "providers", label: "🤖 Providers" },
  { command: "models", label: "🧠 Models" },
  { command: "settings", label: "⚙️ Settings" },
  { command: "status", label: "📊 Status" },
  { command: "ea", label: "📄 EA File" },
  { command: "reset", label: "🔄 Reset" },
  { command: "help", label: "❓ Help" },
];

function menuKeyboard(): ReturnType<typeof keyboard> {
  const rows: ReturnType<typeof coloredButton>[][] = [];
  for (let i = 0; i < MENU_BUTTONS.length; i += 2) {
    rows.push(MENU_BUTTONS.slice(i, i + 2).map((b) => coloredButton(b.label, "blue", `menucmd:${b.command}`)));
  }
  return keyboard(rows);
}

async function handleMenu(deps: CommandRouterDeps, chatId: number): Promise<void> {
  await deps.client.sendMessage({ chat_id: chatId, text: "<b>Menu</b>\nTap a command:", parse_mode: "HTML", reply_markup: menuKeyboard() });
}

export async function dispatchCommand(deps: CommandRouterDeps, chatId: number, historyKey: string, text: string): Promise<boolean> {
  const parsed = parseCommand(text);
  if (!parsed) return false;
  await dispatchCommandByName(deps, chatId, historyKey, parsed.command);
  return true;
}

const RISK_FIELDS = ["sl", "tp", "lot"] as const;
type RiskField = (typeof RISK_FIELDS)[number];
/** Button-driven cycling deliberately skips "on" -- that mode requires the user's own exact numeric value (OnModeRequiresValueError), which a button tap can't supply; cycling only ever toggles between off/auto. Setting "on" stays a conversational action. */
function nextMode(mode: RiskMode): RiskMode {
  return mode === "off" ? "auto" : "off";
}

/** Real callback_query dispatch -- every inline button this bot sends resolves here. Always answers the callback (Telegram shows a loading spinner on the button until it's acknowledged). */
export async function dispatchCallback(deps: CommandRouterDeps, callback: TelegramCallbackQuery): Promise<void> {
  const chatId = callback.message?.chat.id;
  const data = callback.data ?? "";
  let ackText: string | undefined;

  // Real fix (user: "confirmation message after EVERY setting change, not just risky ones") --
  // a re-rendered screen plus a transient callback-answer toast (easy to miss, and not what
  // Telegram shows for a plain button tap without `show_alert`) isn't the same as a real,
  // persisted "✅ X set to Y" message showing exactly what changed. This sends that for every
  // real settings mutation below, on top of (not instead of) re-rendering the screen.
  const confirm = async (text: string) => {
    if (chatId) await deps.client.sendMessage({ chat_id: chatId, text: `✅ ${text}`, parse_mode: "HTML" });
  };

  const renderInPlace = async (text: string, reply_markup: ReturnType<typeof keyboard>) => {
    if (!chatId || !callback.message) return;
    await deps.client.editMessageText({ chat_id: chatId, message_id: callback.message.message_id, text, parse_mode: "HTML", reply_markup }).catch(() =>
      deps.client.sendMessage({ chat_id: chatId, text, parse_mode: "HTML", reply_markup })
    );
  };

  try {
    if (data.startsWith("cyclemode:")) {
      const field = data.slice("cyclemode:".length) as RiskField;
      if (RISK_FIELDS.includes(field)) {
        const settings = getRiskSettings(deps.userId);
        const current = field === "sl" ? settings.slMode : field === "tp" ? settings.tpMode : settings.lotMode;
        setRiskMode(deps.userId, field, nextMode(current));
        const updated = getRiskSettings(deps.userId);
        const newLabel = field === "sl" ? modeLabel(updated.slMode, updated.slValue) : field === "tp" ? modeLabel(updated.tpMode, updated.tpValue) : modeLabel(updated.lotMode, updated.lotValue);
        ackText = `${field.toUpperCase()} updated`;
        await confirm(`${field.toUpperCase()} set to ${newLabel}`);
        await renderInPlace("<b>Risk / Trading</b>", riskSettingsKeyboard(deps.userId));
      }
    } else if (data === "settings:top") {
      ackText = undefined;
      await renderInPlace("<b>Settings</b>\nTrading-rule content (what/when/how to trade) lives in your uploaded rules file, never here.", settingsTopKeyboard());
    } else if (data === "settings:risk") {
      ackText = undefined;
      await renderInPlace("<b>Risk / Trading</b>", riskSettingsKeyboard(deps.userId));
    } else if (data.startsWith("proposelimit:")) {
      const field = data.slice("proposelimit:".length) as ProtectedLimitField;
      setPendingLimitEntry(deps.userId, field);
      ackText = undefined;
      const prompt = field === "maxOpenTrades" ? "Reply with the new max open trades (a number) as your next message." : "Reply with the new max daily loss % (a number) as your next message.";
      if (chatId) await deps.client.sendMessage({ chat_id: chatId, text: prompt });
    } else if (data === "settings:tradingmode") {
      ackText = undefined;
      await renderInPlace("<b>Trading Mode</b>", tradingModeKeyboard(deps.userId));
    } else if (data === "tradingmode:auto") {
      setTradingMode(deps.userId, "auto");
      ackText = "Trading mode set to Auto";
      await confirm("Trading mode: Auto");
      await renderInPlace("<b>Trading Mode</b>", tradingModeKeyboard(deps.userId));
    } else if (data === "tradingmode:pickskill") {
      ackText = undefined;
      await renderInPlace("<b>Pick a skill to lock to</b>", skillPickerKeyboard(deps.userId));
    } else if (data.startsWith("tradingmode:setskill:")) {
      const skillId = data.slice("tradingmode:setskill:".length);
      try {
        setTradingMode(deps.userId, "trading-skills", skillId);
        const skillName = listSkills(deps.userId).find((s) => s.id === skillId)?.name ?? skillId;
        ackText = "Trading mode set to Trading Skills";
        await confirm(`Trading mode: Trading Skills (locked to "${skillName}")`);
      } catch (err) {
        ackText = err instanceof TradingSkillsModeRequiresSkillError ? err.message : `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
      await renderInPlace("<b>Trading Mode</b>", tradingModeKeyboard(deps.userId));
    } else if (data === "settings:pairgroup") {
      ackText = undefined;
      const view = pairGroupKeyboard(deps.userId);
      await renderInPlace(view.text, view.reply_markup);
    } else if (data.startsWith("pairgroup:active:")) {
      const groupId = data.slice("pairgroup:active:".length);
      setActiveGroup(deps.userId, groupId);
      const groupName = listGroups(deps.userId).find((g) => g.id === groupId)?.name ?? groupId;
      ackText = "Active pair group updated";
      await confirm(`Active group: ${groupName}`);
      const view = pairGroupKeyboard(deps.userId);
      await renderInPlace(view.text, view.reply_markup);
    } else if (data.startsWith("pairgroup:fallback:")) {
      const groupId = data.slice("pairgroup:fallback:".length);
      setFallbackGroup(deps.userId, groupId);
      const groupName = listGroups(deps.userId).find((g) => g.id === groupId)?.name ?? groupId;
      ackText = "Fallback pair group updated";
      await confirm(`Fallback group: ${groupName}`);
      const view = pairGroupKeyboard(deps.userId);
      await renderInPlace(view.text, view.reply_markup);
    } else if (data === "settings:voice") {
      ackText = undefined;
      const view = voiceSettingsView(deps);
      await renderInPlace(view.text, view.reply_markup);
    } else if (data.startsWith("voice:setkey:")) {
      const provider = data.slice("voice:setkey:".length) as "fish-audio" | "elevenlabs";
      setPendingTtsKeyEntry(deps.db, deps.userId, provider);
      ackText = undefined;
      if (chatId) await deps.client.sendMessage({ chat_id: chatId, text: `Reply with your ${provider} API key as your next message.` });
    } else if (data.startsWith("voice:manualvoice:")) {
      setPendingVoiceIdEntry(deps.db, deps.userId, "fish-audio");
      ackText = undefined;
      if (chatId) await deps.client.sendMessage({ chat_id: chatId, text: "Reply with your Fish Audio reference_id (voice ID) as your next message." });
    } else if (data.startsWith("voice:fetchvoices:")) {
      const key = getTtsProviderKey(deps.db, deps.userId, "elevenlabs");
      if (!key) {
        ackText = "No ElevenLabs key configured -- add one in the admin panel first";
      } else {
        try {
          const voices = await new ElevenLabsClient(key).listVoices();
          fetchedVoicesCache.set(deps.userId, voices);
          ackText = `${voices.length} voices fetched`;
          if (chatId) {
            const settings = getVoiceSettings(deps.db, deps.userId);
            await deps.client.sendMessage({
              chat_id: chatId,
              text: `<b>ElevenLabs voices</b> (${voices.length}) -- tap to select:`,
              parse_mode: "HTML",
              reply_markup: buildVoicePickerKeyboard("elevenlabs", voices, settings.elevenlabsVoiceId),
            });
          }
        } catch (err) {
          ackText = `Real fetch failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    } else if (data.startsWith("voice:pick:")) {
      const parsed = parseVoiceCallback(data);
      if (parsed?.action === "pick") {
        setVoiceId(deps.db, deps.userId, parsed.provider, parsed.voiceId);
        ackText = `Voice set to ${parsed.voiceId}`;
        await confirm(`ElevenLabs voice: <code>${parsed.voiceId}</code>`);
      }
    } else if (data.startsWith("voice:")) {
      const parsed = parseVoiceCallback(data);
      if (parsed?.action === "toggle") {
        const settings = getVoiceSettings(deps.db, deps.userId);
        setVoiceEnabled(deps.db, deps.userId, !settings.enabled);
        ackText = `Voice ${!settings.enabled ? "enabled" : "disabled"}`;
        await confirm(`Voice: ${!settings.enabled ? "On" : "Off"}`);
      } else if (parsed?.action === "provider") {
        setActiveProvider(deps.db, deps.userId, parsed.provider);
        ackText = `TTS provider set to ${parsed.provider}`;
        await confirm(`TTS provider: ${parsed.provider}`);
      }
      const view = voiceSettingsView(deps);
      await renderInPlace(view.text, view.reply_markup);
    } else if (data === "settings:trailing") {
      ackText = undefined;
      const view = trailingKeyboard(deps.userId);
      await renderInPlace(view.text, view.reply_markup);
    } else if (data.startsWith("trailing:")) {
      const field = data.slice("trailing:".length) as TrailingField;
      setPendingTrailingEntry(deps.userId, field);
      ackText = undefined;
      if (chatId) await deps.client.sendMessage({ chat_id: chatId, text: `Reply with the ${field} SL price level as your next message.` });
    } else if (data === "settings:notifications") {
      ackText = undefined;
      await renderInPlace("<b>Notifications</b>", notificationsKeyboard(deps));
    } else if (data === "notif:togglepush") {
      const settings = getNotificationSettings(deps.db, deps.userId);
      setPushEnabled(deps.db, deps.userId, !settings.pushEnabled);
      ackText = `Push ${!settings.pushEnabled ? "enabled" : "disabled"}`;
      await confirm(`Push notifications: ${!settings.pushEnabled ? "On" : "Off"}`);
      await renderInPlace("<b>Notifications</b>", notificationsKeyboard(deps));
    } else if (data === "notif:toggletradeopened") {
      const settings = getNotificationSettings(deps.db, deps.userId);
      setTradeOpenedEnabled(deps.db, deps.userId, !settings.tradeOpenedEnabled);
      ackText = `Trade-opened alert ${!settings.tradeOpenedEnabled ? "enabled" : "disabled"}`;
      await confirm(`Trade-opened alert: ${!settings.tradeOpenedEnabled ? "On" : "Off"}`);
      await renderInPlace("<b>Notifications</b>", notificationsKeyboard(deps));
    } else if (data === "notif:toggleemail") {
      const settings = getNotificationSettings(deps.db, deps.userId);
      setEmailEnabled(deps.db, deps.userId, !settings.emailEnabled);
      ackText = !settings.emailEnabled ? "Saved -- but no email sender is configured yet, so nothing will actually be emailed" : "Email disabled";
      await confirm(`Email notifications: ${!settings.emailEnabled ? "On" : "Off"} (real email sending isn't built yet -- this only stores your preference)`);
      await renderInPlace("<b>Notifications</b>", notificationsKeyboard(deps));
    } else if (data === "settings:e2b") {
      ackText = undefined;
      const view = e2bKeyboard(deps);
      await renderInPlace(view.text, view.reply_markup);
    } else if (data === "e2bkey:add") {
      setPendingE2BKeyEntry(deps.db, deps.userId, true);
      ackText = undefined;
      if (chatId) await deps.client.sendMessage({ chat_id: chatId, text: "Reply with your E2B API key as your next message." });
    } else if (data.startsWith("e2bkey:remove:")) {
      const keyId = data.slice("e2bkey:remove:".length);
      removeE2BKey(deps.db, deps.userId, keyId);
      ackText = "Key removed";
      await confirm("E2B key removed");
      const view = e2bKeyboard(deps);
      await renderInPlace(view.text, view.reply_markup);
    } else if (data.startsWith("e2bkey:noop:")) {
      ackText = undefined;
    } else if (data === "settings:memory") {
      ackText = undefined;
      await renderInPlace("<b>Memory</b>", memoryKeyboard(deps.userId));
    } else if (data === "togglewriteapproval") {
      const enabled = getWriteApprovalSetting(deps.userId);
      setWriteApprovalSetting(deps.userId, !enabled);
      ackText = `Write-approval ${!enabled ? "enabled" : "disabled"}`;
      await confirm(`Ask before saving to memory: ${!enabled ? "On" : "Off"}`);
      await renderInPlace("<b>Memory</b>", memoryKeyboard(deps.userId));
    } else if (data === "toggleautoapproval") {
      const enabled = getAutoApprovalEnabled(deps.userId);
      setAutoApprovalEnabled(deps.userId, !enabled);
      ackText = `Auto-approval ${!enabled ? "enabled" : "disabled"}`;
      await confirm(`Auto-approve Dave's proposals: ${!enabled ? "On" : "Off"}`);
      await renderInPlace("<b>Memory</b>", memoryKeyboard(deps.userId));
    } else if (data.startsWith("menucmd:")) {
      const command = data.slice("menucmd:".length) as DaveCommand;
      ackText = undefined;
      if (chatId) await dispatchCommandByName(deps, chatId, `${deps.userId}:${chatId}`, command);
    } else if (data.startsWith("provider:")) {
      const name = data.slice("provider:".length) as ProviderName;
      ackText = undefined;
      if (chatId && callback.message) {
        const view = providerDetailView(deps, name);
        await deps.client.editMessageText({ chat_id: chatId, message_id: callback.message.message_id, text: view.text, parse_mode: "HTML", reply_markup: view.reply_markup }).catch(() =>
          deps.client.sendMessage({ chat_id: chatId, text: view.text, parse_mode: "HTML", reply_markup: view.reply_markup })
        );
      }
    } else if (data.startsWith("addkey:")) {
      const provider = data.slice("addkey:".length) as ProviderName;
      setPendingKeyEntry(deps.db, deps.userId, provider);
      ackText = undefined;
      if (chatId) {
        await deps.client.sendMessage({
          chat_id: chatId,
          text: `Reply with your ${provider} API key as your next message.\n\nTo add multiple at once (up to 10), paste one per line -- each is validated and stored individually, so one bad line never blocks the rest.`,
        });
      }
    } else if (data === "providers:back") {
      ackText = undefined;
      if (chatId) await handleProviders(deps, chatId);
    } else if (data.startsWith("activatekey:")) {
      const keyId = data.slice("activatekey:".length);
      const key = getProviderKeyById(deps.db, deps.userId, keyId);
      if (!key?.provider) {
        ackText = "Key not found";
      } else {
        setPrimaryProviderKey(deps.db, deps.userId, keyId);
        const config = getModelConfig(deps.userId);
        setModelConfig(deps.userId, { primary: key.provider, fallback: config.fallback.filter((p) => p !== key.provider) });
        ackText = "Key activated";
        await confirm(`Provider switched to ${key.provider} (key: ${key.label})`);
        if (chatId && callback.message) {
          const view = providerDetailView(deps, key.provider);
          await deps.client.editMessageText({ chat_id: chatId, message_id: callback.message.message_id, text: view.text, parse_mode: "HTML", reply_markup: view.reply_markup }).catch(() =>
            deps.client.sendMessage({ chat_id: chatId, text: view.text, parse_mode: "HTML", reply_markup: view.reply_markup })
          );
        }
      }
    } else if (data.startsWith("setprimaryprovider:")) {
      const name = data.slice("setprimaryprovider:".length) as ProviderName;
      const config = getModelConfig(deps.userId);
      setModelConfig(deps.userId, { primary: name, fallback: config.fallback.filter((p) => p !== name) });
      ackText = `Primary provider set to ${name}`;
      await confirm(`Provider switched to ${name}`);
      if (chatId && callback.message) {
        const view = providerDetailView(deps, name);
        await deps.client.editMessageText({ chat_id: chatId, message_id: callback.message.message_id, text: view.text, parse_mode: "HTML", reply_markup: view.reply_markup }).catch(() =>
          deps.client.sendMessage({ chat_id: chatId, text: view.text, parse_mode: "HTML", reply_markup: view.reply_markup })
        );
      }
    } else if (data.startsWith("fetchmodels:")) {
      const name = data.slice("fetchmodels:".length) as ProviderName;
      const key = primaryKeyFor(deps, name);
      if (!key) {
        ackText = "No key configured for this provider";
      } else {
        const result = await fetchAvailableModels(name, key.config);
        if (result.manualEntryRequired) {
          // Defensive: /models never shows a fetch button for a manual-entry (or endpoint-less)
          // provider, but a stale keyboard from before a catalog change could still be tapped.
          ackText = `${name} has no live model list -- reply with the model ID as a message instead`;
        } else if (result.error) {
          ackText = `Fetch failed: ${result.error}`;
          if (chatId) await deps.client.sendMessage({ chat_id: chatId, text: `Real fetch failed: ${result.error}` });
        } else {
          fetchedModelsCache.set(deps.userId, { provider: name, models: result.models });
          ackText = `${result.models.length} models fetched`;
          if (chatId) {
            const rows: ReturnType<typeof coloredButton>[][] = [];
            for (let i = 0; i < result.models.length; i += 2) {
              const pair = result.models.slice(i, i + 2);
              rows.push(pair.map((m, j) => coloredButton(m, "neutral", `pickmodel:${i + j}`)));
            }
            await deps.client.sendMessage({
              chat_id: chatId,
              text: `<b>${name}'s live models</b> (${result.models.length}) -- tap to select:`,
              parse_mode: "HTML",
              reply_markup: keyboard(rows),
            });
          }
        }
      }
    } else if (data.startsWith("pickmodel:")) {
      const index = Number(data.slice("pickmodel:".length));
      const cached = fetchedModelsCache.get(deps.userId);
      if (!cached || !Number.isInteger(index) || !cached.models[index]) {
        ackText = "That list expired -- fetch again";
      } else {
        const modelId = cached.models[index];
        const key = primaryKeyFor(deps, cached.provider);
        if (!key) {
          ackText = "No key configured for this provider";
        } else {
          editProviderKey(deps.db, deps.userId, key.id, { config: { model: modelId } });
          ackText = `Model set to ${modelId}`;
          if (chatId) await deps.client.sendMessage({ chat_id: chatId, text: `Model for <b>${cached.provider}</b> set to <code>${modelId}</code>.`, parse_mode: "HTML" });
        }
      }
    } else if (data.startsWith("approve:") || data.startsWith("decline:")) {
      const [action, , pendingId] = data.split(":");
      if (action === "approve") {
        const settings = approveSettingsChange(deps.userId, pendingId);
        ackText = "Approved";
        if (chatId)
          await deps.client.sendMessage({
            chat_id: chatId,
            text: `✅ Approved. SL=${modeLabel(settings.slMode, settings.slValue)} TP=${modeLabel(settings.tpMode, settings.tpValue)} Lot=${modeLabel(settings.lotMode, settings.lotValue)} MaxOpenTrades=${settings.maxOpenTrades ?? "not set"} MaxDailyLoss=${settings.maxDailyLossPct ?? "not set"}%`,
          });
      } else {
        declineSettingsChange(deps.userId, pendingId);
        ackText = "Declined";
        if (chatId) await deps.client.sendMessage({ chat_id: chatId, text: "Declined -- no change made." });
      }
    } else if (data === "ea:default" || data === "ea:own") {
      // Known gap (ea-file.ts): both buttons currently lead to the same personalized-EA flow; "own account" branching needs separate-credentials storage (Step 10.8), not faked here.
      if (chatId) {
        const { filename, content, webhookUrl, token } = personalizeEaFile(deps.userId, deps.publicBaseUrl);
        await deps.client.sendDocument({
          chat_id: chatId,
          document: { buffer: Buffer.from(content, "utf8"), filename },
          caption: `Your personalized EA -- webhook URL and token are already filled in.\n\nWebhook: ${webhookUrl}\nToken: ${token}\n\nDrop it in MQL5/Experts/DAVEMA/, compile with F7, attach to a chart.`,
          parse_mode: "HTML",
        });
      }
      ackText = "Sent";
    } else if (data === "settings:back") {
      ackText = undefined;
    }
  } catch (err) {
    ackText = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }

  await deps.client.answerCallbackQuery({ callback_query_id: callback.id, text: ackText }).catch(() => undefined);
}

export function listPendingApprovalsKeyboard(pendingId: string) {
  return approvalKeyboard(pendingId, "risk-settings");
}

export { listPendingLimitChanges };
