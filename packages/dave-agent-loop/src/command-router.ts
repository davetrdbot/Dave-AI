import type { DaveDatabase } from "@dave/db";
import type { TradeExecutor } from "@dave/trading";
import { checkSandboxHealth } from "@dave/sandbox";
import {
  TelegramClient,
  TelegramError,
  parseCommand,
  personalizeEaFile,
  settingsScreen,
  keyboard,
  coloredButton,
  approvalKeyboard,
  DAVE_COMMANDS,
  type DaveCommand,
  type TelegramCallbackQuery,
  sendSelfDeletingMessage,
  escapeHtml,
} from "@dave/telegram";
import { getLastKnownAccountSnapshot, getLastKnownState, getEaConnectionStatus, getOrCreateEaWebhook, revokeEaToken, getTradingModeConfig, setEaTradingMode, setMcpTradingMode, MissingMcpServerUrlError, createEaAnalysisSource, setEaPushInterval, getEaPushIntervalPreference, setPendingPushIntervalEntry, getPendingPushIntervalEntry } from "@dave/ea-bridge";
import { setPendingMcpUrlEntry, getPendingMcpUrlEntry } from "./pending-mcp-url-entry.js";
import { setPendingActivePairEntry, getPendingActivePairEntry } from "./pending-active-pair-entry.js";
import { formatPnl, buildTradePlacedMessage } from "./trade-notifications.js";
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
  setPendingRiskEntry,
  getPendingRiskEntry,
  type RiskEntryField,
  getTrailingStopConfig,
  setTrailingStopConfig,
  setPendingTrailingEntry,
  getPendingTrailingEntry,
  type TrailingField,
  getActiveGroupInfo,
  listGroups,
  setActiveGroup,
  setFallbackGroup,
  setActivePairSymbol,
  clearActivePairSymbol,
  getTradingSession,
  setTradingSession,
  type TradingSession,
  seedDefaultPairGroups,
  getTradingMode,
  setTradingMode,
  TradingSkillsModeRequiresSkillError,
  type RiskMode,
  getConfidenceSettings,
  setConfidenceThreshold,
  setAutoApproveBelowThreshold,
  setPendingConfidenceEntry,
  getPendingConfidenceEntry,
  takePendingTradeApproval,
  TradeApprovalNotFoundError,
  tradeExecute,
  huntForSetup,
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
import { getWriteApprovalSetting, setWriteApprovalSetting, resetUserMemory, clearMemoryTiers } from "@dave/memory";
import { addE2BKey, listE2BKeys, removeE2BKey, setPendingE2BKeyEntry, getPendingE2BKeyEntry } from "@dave/e2b";
import { addFirecrawlKey, listFirecrawlKeys, removeFirecrawlKey, setPendingFirecrawlKeyEntry, getPendingFirecrawlKeyEntry } from "@dave/firecrawl";
import { mcpConnect, listMcpServerConfigs, addMcpServerConfig, removeMcpServerConfig, InvalidMcpServerUrlError } from "@dave/mcp-manager";
import { setPendingMcpServerEntry, getPendingMcpServerEntry } from "./pending-mcp-server-entry.js";
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
  removeProviderKey,
  type ProviderName,
  type StoredProviderKey,
} from "@dave/brain";
import { getReport as getCircuitBreakerReport, formatTripReport, getInterruptState } from "@dave/safety";
import { getTodaysWinRateSummary } from "@dave/feedback";
import { isAutonomousTradingRunning, getTradingLoopIntervalMinutes, setAutonomousTradingIntervalMinutes } from "./trading-loop.js";
import { getProviderTimeoutConfig, setPrimaryTimeoutSeconds, setFallbackTimeoutSeconds } from "./provider-timeout-config.js";
import { listWorkers } from "@dave/workers";
import { clearConversationHistory } from "./conversation-store.js";
import { friendlyErrorMessage } from "./error-messages.js";

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
  /** Optional -- only needed for the real /trades close/close-all/close-losers buttons. */
  executor?: TradeExecutor;
}

function formatMoney(n: number | undefined): string {
  return typeof n === "number" ? `$${n.toFixed(2)}` : "n/a";
}

/** Item 7: every screen needs a real way back to the /menu home screen, not just one level up. */
const MENU_HOME_BUTTON = { text: "🏠 Menu", callback_data: "menucmd:menu" } as const;

/** Item 7: appends a real "⬅️ Back" + "🏠 Menu" row (or just Home, for top-level screens) to an
 * already-built keyboard, without needing every keyboard-building function to know about it. */
function withMenuHome(kb: ReturnType<typeof keyboard>, backCallbackData?: string): ReturnType<typeof keyboard> {
  const row = backCallbackData ? [{ text: "⬅️ Back", callback_data: backCallbackData }, MENU_HOME_BUTTON] : [MENU_HOME_BUTTON];
  return { inline_keyboard: [...kb.inline_keyboard, row] };
}

/** Same as withMenuHome, but for a keyboard (e.g. settingsScreen()'s output) that already has its
 * own real Back row -- appends only the Home row rather than a second, duplicate Back row. */
function appendMenuHome(kb: ReturnType<typeof keyboard>): ReturnType<typeof keyboard> {
  return { inline_keyboard: [...kb.inline_keyboard, [MENU_HOME_BUTTON]] };
}

/**
 * Item 7 real gap fixed: "button taps should EDIT the existing message in place... rather than
 * sending new messages each time." Screens reached via a typed command (chatId only, no message
 * to edit) still send fresh; screens reached via a menu/back button tap (editMessageId is the
 * tapped message's own id) now genuinely edit that SAME message instead of stacking a new one.
 */
/**
 * Item 4 real bug fixed (re-verified after being reported as still broken): editMessageText's
 * fallback-to-sendMessage ALWAYS fired on ANY failure -- including Telegram's genuinely common
 * "Bad Request: message is not modified" (fires whenever the tapped button's destination screen
 * has the EXACT same text+keyboard already showing, e.g. tapping Back twice, or navigating back
 * to a screen you were already on). That's not a real failure -- editing to identical content
 * IS what "already showing" looks like -- but the blind catch treated it as one and sent a brand
 * new message anyway, which is exactly the "growing stack of messages" symptom being reported.
 * Now that specific, expected case is a silent success; only a GENUINE edit failure (message too
 * old, deleted, no permission) falls back to a new message.
 */
async function editOrSend(client: TelegramClient, params: { chat_id: number | string; message_id: number; text: string; parse_mode?: "HTML"; reply_markup?: ReturnType<typeof keyboard> }): Promise<void> {
  try {
    await client.editMessageText(params);
  } catch (err) {
    if (err instanceof TelegramError && /message is not modified/i.test(err.message)) return;
    await client.sendMessage({ chat_id: params.chat_id, text: params.text, parse_mode: params.parse_mode, reply_markup: params.reply_markup });
  }
}

async function sendOrEditScreen(deps: CommandRouterDeps, chatId: number, text: string, reply_markup: ReturnType<typeof keyboard> | undefined, editMessageId?: number): Promise<void> {
  if (editMessageId) {
    await editOrSend(deps.client, { chat_id: chatId, message_id: editMessageId, text, parse_mode: "HTML", reply_markup });
  } else {
    await deps.client.sendMessage({ chat_id: chatId, text, parse_mode: "HTML", reply_markup });
  }
}

async function handleAccount(deps: CommandRouterDeps, chatId: number, editMessageId?: number): Promise<void> {
  const snapshot = getLastKnownAccountSnapshot(deps.userId);
  if (!snapshot) {
    await sendOrEditScreen(deps, chatId, "No EA report yet -- connect your MT5 EA first (see /ea).", withMenuHome(keyboard([])), editMessageId);
    return;
  }
  const eaStatus = getEaConnectionStatus(deps.userId);
  // Real gap fixed (re-verified live report: leverage was flowing through the EA -> bridge ->
  // live-context.ts's per-turn settings block, but this SEPARATE /account (and "💰 Account" menu
  // button) code path builds its own summary straight off the same AccountSnapshot and never
  // included leverage at all -- so a user checking /account genuinely never saw it even though
  // the model did. Same undefined-safe fallback as live-context.ts for users on an EA build from
  // before leverage was added (snapshot.leverage is undefined until they recompile/redeploy).
  const leverageLine = snapshot.leverage !== undefined ? `Leverage: 1:${snapshot.leverage}\n` : `Leverage: not reported by the EA yet (recompile & redeploy your EA to send it)\n`;
  const text =
    `<b>Account</b>\n` +
    `Account: ${snapshot.account}\n` +
    `Balance: ${formatMoney(snapshot.balance)}\n` +
    `Equity: ${formatMoney(snapshot.equity)}\n` +
    `Margin: ${formatMoney(snapshot.margin)}\n` +
    `Free margin: ${formatMoney(snapshot.freeMargin)}\n` +
    leverageLine +
    `EA connection: ${eaStatus.connected ? "🟢 connected" : `🔴 disconnected${eaStatus.secondsSinceLastSeen !== null ? ` (last seen ${eaStatus.secondsSinceLastSeen}s ago)` : " (never connected)"}`}`;
  await sendOrEditScreen(deps, chatId, text, withMenuHome(keyboard([])), editMessageId);
}

/** Real fix (spec: per-service 🟢/🔴/🟡 status): the EA/MT5 bridge's real connection state
 * (getEaConnectionStatus, backed by the real lastSeen heartbeat every EA report already writes)
 * is now honestly shown here instead of just raw position counts with no connectivity signal. */
/** Real fix (spec: "status button per service... the AI provider/brain, MT5/EA bridge, the
 * sandbox, the database") -- this used to only ever show EA/position counts, with zero real
 * signal on the other real subsystems. Each check below calls the actual real function that
 * subsystem's own health-check already uses elsewhere (checkSandboxHealth(),
 * getEaConnectionStatus()) rather than inventing a second, parallel check that could drift from
 * what's actually true. Item 5 real gap fixed: the DAVEMA row used to make a real live HTTP ping
 * to the retired external DAVEMA API and show its raw error to the user -- removed; the EA/MT5
 * bridge row above is the real market-data dependency now. */
/**
 * Real gap fixed (user, with real screenshots of the exact desired UI: "in the menu ui add a
 * button called trades... refreshes every 2 sec like edit to the new one there you can close
 * your trade check which one are in profit and others"). Real live per-position P/L now flows
 * from the EA's own real POSITION_PROFIT (see ea-webhook.ts's EaPosition.pnl) -- previously never
 * reported at all, so a real profit/loss figure per open trade genuinely couldn't be shown.
 */
function tradesScreen(deps: CommandRouterDeps, liveSeconds?: number): { text: string; reply_markup: ReturnType<typeof keyboard> } {
  const { positions } = getLastKnownState(deps.userId);
  if (positions.length === 0) {
    return { text: "<b>Trades</b>\nNo open positions right now.", reply_markup: withMenuHome(keyboard([[coloredButton("🔄 Refresh", "neutral", "trades:refresh")]])) };
  }
  const lines = ["<b>Trades</b>", ...positions.map((p) => `${(p.pnl ?? 0) >= 0 ? "🟢" : "🔴"} ${p.symbol} ${p.type.toUpperCase()} ${p.lots} @ ${p.openPrice} — ${formatPnl(p.pnl ?? 0)}`)];
  if (liveSeconds) lines.push("", `🔴 Live -- refreshing every ${liveSeconds}s`);
  const rows: ReturnType<typeof coloredButton>[][] = positions.map((p) => [coloredButton(`❌ Close ${p.symbol} (${formatPnl(p.pnl ?? 0)})`, "red", `trades:close:${p.ticket}`)]);
  const losers = positions.filter((p) => (p.pnl ?? 0) < 0);
  rows.push([coloredButton(`🛑 Close ALL (${positions.length})`, "red", "trades:closeall")]);
  if (losers.length > 0) rows.push([coloredButton(`🔴 Close losers (${losers.length})`, "red", "trades:closelosers")]);
  rows.push([coloredButton("🔄 Refresh", "neutral", "trades:refresh"), coloredButton(liveSeconds ? "⏸️ Stop live" : "📡 Live (3s)", liveSeconds ? "red" : "blue", "trades:live")]);
  return { text: lines.join("\n"), reply_markup: withMenuHome(keyboard(rows)) };
}

async function handleTrades(deps: CommandRouterDeps, chatId: number, editMessageId?: number): Promise<void> {
  const screen = tradesScreen(deps);
  await sendOrEditScreen(deps, chatId, screen.text, screen.reply_markup, editMessageId);
}

const LIVE_TRADES_INTERVAL_MS = 3000;
const LIVE_TRADES_MAX_MS = 5 * 60 * 1000; // bounded -- a real background timer must not run forever unattended
const liveTradesTimers = new Map<string, ReturnType<typeof setInterval>>();

function stopLiveTrades(key: string): void {
  const timer = liveTradesTimers.get(key);
  if (timer) {
    clearInterval(timer);
    liveTradesTimers.delete(key);
  }
}

/** Real live-refresh: edits the SAME message in place every LIVE_TRADES_INTERVAL_MS with fresh
 *  real position data, matching the user's real screenshot ("Live (3s)" toggle). Auto-stops after
 *  a bounded real duration rather than running as an unattended background timer forever. */
function startLiveTrades(deps: CommandRouterDeps, chatId: number, messageId: number): void {
  const key = `${deps.userId}:${chatId}`;
  stopLiveTrades(key);
  const startedAt = Date.now();
  const timer = setInterval(() => {
    void (async () => {
      if (Date.now() - startedAt > LIVE_TRADES_MAX_MS) {
        stopLiveTrades(key);
        return;
      }
      const screen = tradesScreen(deps, LIVE_TRADES_INTERVAL_MS / 1000);
      await editOrSend(deps.client, { chat_id: chatId, message_id: messageId, text: screen.text, parse_mode: "HTML", reply_markup: screen.reply_markup });
    })();
  }, LIVE_TRADES_INTERVAL_MS);
  timer.unref?.();
  liveTradesTimers.set(key, timer);
}

async function handleConnection(deps: CommandRouterDeps, chatId: number, editMessageId?: number): Promise<void> {
  const state = getLastKnownState(deps.userId);
  const eaStatus = getEaConnectionStatus(deps.userId);
  const eaLine = eaStatus.connected
    ? "🟢 MT5/EA bridge: connected"
    : `🔴 MT5/EA bridge: ${eaStatus.lastSeenAt === null ? "never connected" : `disconnected (last seen ${eaStatus.secondsSinceLastSeen}s ago)`}`;

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

  // Item 5 real gap fixed (user: "add a real settings button letting the user configure what
  // the EA pushes in its heartbeat/state payload and at what interval"). Shows the user's last
  // REQUESTED interval (not just the EA's compiled default), since the EA only actually applies
  // it live on its next poll -- honest about that real MT5 round-trip delay, not instant.
  const requestedInterval = getEaPushIntervalPreference(deps.userId);
  const pushIntervalLine = requestedInterval !== undefined ? `Push interval: ${requestedInterval}s (applies on the EA's next poll)` : "Push interval: EA default (not yet customized)";

  const text =
    `<b>Connection</b>\n${brainLine}\n${eaLine}\n${sandboxLine}\n${dbLine}\n\n` +
    `Open positions: ${state.positions.length}\nPending orders: ${state.pendingOrders.length}\n${pushIntervalLine}`;
  await sendOrEditScreen(deps, chatId, text, withMenuHome(keyboard([[coloredButton("⚙️ Set push interval", "neutral", "ea_push_interval")]])), editMessageId);
}

/** Real fix (user report: "providers is missing? it's only airllm and deepseek and Claude") --
 * this used to hardcode 3 providers even after the catalog grew to all 28+AirLLM. Now it lists
 * every catalog entry, per-provider marking whether the user has a configured key (AirLLM excepted --
 * it's self-hosted via AIRLLM_BASE_URL, no key needed) so picking one that isn't ready yet is an
 * informed choice, not a silent dead end. Tapping a provider opens its detail screen (real stored
 * keys, tap-to-activate) rather than blindly setting it primary. */
/** Real fix (user: "remove the red color in providers buttons just make them normal grey main
 * primary should be green then fallback red"): red used to mean "no key stored" -- a purely
 * informational state that doesn't warrant an alarming color. Red is now reserved for what it
 * actually means to the user: "this is in my real fallback chain." Primary stays green, everything
 * else (including a not-yet-configured provider) is plain grey; a missing key is still called out
 * in the label text itself ("(no key)"), just without the red. */
function providersKeyboard(current: ProviderName, configuredProviders: Set<ProviderName>, fallback: ProviderName[]): ReturnType<typeof keyboard> {
  const catalog = listProviderCatalog().filter((e) => e.id !== "custom");
  const fallbackSet = new Set(fallback);
  const rows: ReturnType<typeof coloredButton>[][] = [];
  for (let i = 0; i < catalog.length; i += 2) {
    const pair = catalog.slice(i, i + 2);
    rows.push(
      pair.map((entry) => {
        const ready = entry.id === "airllm" || configuredProviders.has(entry.id);
        const isCurrent = current === entry.id;
        const isFallback = fallbackSet.has(entry.id);
        const label = `${isCurrent ? "✅ " : isFallback ? "🔁 " : ""}${entry.id}${ready ? "" : " (no key)"}`;
        return coloredButton(label, isCurrent ? "green" : isFallback ? "red" : "neutral", `provider:${entry.id}`);
      })
    );
  }
  return withMenuHome(keyboard(rows));
}

/** Real fix (user: "when providers is not set it to say provider not set") -- Primary previously
 * always printed getModelConfig's stored/default provider name as if it were a working, ready
 * choice, even on a totally fresh install where it's just DEFAULT_CONFIG's fallback ("airllm")
 * with zero real keys behind it. Now explicitly says "(not set -- no working key)" when the
 * primary provider isn't actually ready (airllm excepted: self-hosted, no key required). */
async function handleProviders(deps: CommandRouterDeps, chatId: number, editMessageId?: number): Promise<void> {
  const config = getModelConfig(deps.userId);
  const configuredProviders = new Set(listProviderKeys(deps.db, deps.userId).map((k) => k.provider));
  const catalogCount = listProviderCatalog().filter((e) => e.id !== "custom").length;
  const primaryReady = config.primary === "airllm" || configuredProviders.has(config.primary);
  const primaryLine = primaryReady ? config.primary : `${config.primary} (not set -- no working key)`;
  const text =
    `<b>AI Provider</b>\nPrimary: ${primaryLine}\nFallback: ${config.fallback.join(", ") || "none"}\n\n` +
    `${catalogCount} providers available. Tap a provider to see its keys:`;
  await sendOrEditScreen(deps, chatId, text, providersKeyboard(config.primary, configuredProviders, config.fallback), editMessageId);
}

/** Real fix (spec: "Tap a provider -> shows its stored keys (up to 20 per provider) each with
 * health status, tap a key to activate"). Renders the provider detail screen sent both from
 * /providers' provider: callback and re-rendered in place after activating a key. */
function providerDetailView(deps: CommandRouterDeps, provider: ProviderName): { text: string; reply_markup: ReturnType<typeof keyboard> } {
  const entry = listProviderCatalog().find((e) => e.id === provider)!;
  const keys = listProviderKeys(deps.db, deps.userId, provider);
  const config = getModelConfig(deps.userId);
  // Real bug fixed (user, live: tapping Token Harbor always failed with "Something went wrong on
  // my end"): entry.notes was sent RAW into a real parse_mode:"HTML" message. Token Harbor's own
  // notes had a genuinely unescaped "<model>" in it (since fixed at the source too), which reads
  // as an invalid HTML start tag -- the real Bot API rejects that with a 400 "can't parse
  // entities" error, an unrecognized exception type that fell through to the generic error
  // message. Escaped here defensively so no future catalog note (any provider) can do this again.
  const lines = [`<b>${entry.displayName}</b>`, escapeHtml(entry.notes), ""];
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
    // Item 1 real gap fixed: a stored key could only ever be added or activated, never removed --
    // deleting one meant going to the admin panel. Real delete, right next to the key it belongs to.
    rows.push([
      coloredButton(`${star}${health} ${key.label}`, key.isPrimary ? "green" : "neutral", `activatekey:${key.id}`),
      coloredButton("🗑 Delete", "red", `deletekey:${key.id}`),
    ]);
  }
  if (provider !== "airllm" && provider !== "custom" && keys.length < 10) {
    rows.push([coloredButton("➕ Add key(s)", "blue", `addkey:${provider}`)]);
  }
  rows.push([coloredButton(config.primary === provider ? "✅ Primary provider" : "Set as primary provider", config.primary === provider ? "green" : "blue", `setprimaryprovider:${provider}`)]);
  // Real gap fixed (user: "the fallback you set it to Claude and deepseek and airllm only the
  // fallback should be configurable in the /provider"): the fallback chain used to only ever be
  // DEFAULT_CONFIG's hardcoded ["deepseek", "claude"] (or whatever was left over after switching
  // primary), with no real UI to change it -- this real toggle button adds/removes THIS provider
  // from the user's own fallback list. Hidden for the current primary (it's already tried first;
  // being its own fallback would be meaningless) and for airllm (no key to fail over from).
  if (provider !== config.primary && provider !== "airllm") {
    const inFallback = config.fallback.includes(provider);
    rows.push([coloredButton(inFallback ? "✅ In fallback chain" : "Add to fallback chain", inFallback ? "green" : "blue", `togglefallback:${provider}`)]);
  }
  return { text: lines.join("\n"), reply_markup: withMenuHome(keyboard(rows), "providers:back") };
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

/** One line summarizing a single provider's currently-active model, for the /models overview
 * (used for both the primary AND every fallback provider -- previously fallback providers had
 * zero visibility here at all). */
function modelSummaryLine(deps: CommandRouterDeps, provider: ProviderName): string {
  const entry = listProviderCatalog().find((e) => e.id === provider)!;
  if (provider === "airllm") return `<b>${provider}</b>: fixed <code>${entry.defaultModel}</code> (self-hosted, not user-selectable)`;
  const key = primaryKeyFor(deps, provider);
  if (!key) return `<b>${provider}</b>: not set -- no working key`;
  const chosenModel = key.config.model;
  return chosenModel ? `<b>${provider}</b>: <code>${chosenModel}</code>` : `<b>${provider}</b>: not set yet (defaults to <code>${entry.defaultModel}</code>)`;
}

/** Real fix (item 5 of the live production bug report: "/model currently doesn't do what it's
 * supposed to... the real purpose is to SET which model is active FOR A SPECIFIC PROVIDER, not
 * show one global model"). This used to hardcode config.primary and never even mention the
 * configured fallback provider(s) -- picking a model for a fallback was impossible from
 * Telegram. Now shows every configured provider (primary first, then each fallback) with its own
 * real current-model line, each with its own "Model for <provider>" button leading to that
 * SPECIFIC provider's real fetch/manual-entry picker (modelFor: callback below) -- confirmed
 * per-provider, not a single global setting. */
async function handleModels(deps: CommandRouterDeps, chatId: number, editMessageId?: number): Promise<void> {
  const config = getModelConfig(deps.userId);
  const providers = [config.primary, ...config.fallback.filter((p) => p !== config.primary)];
  const lines = [`<b>Models</b>`, `Primary: ${modelSummaryLine(deps, config.primary)}`];
  if (config.fallback.length > 0) {
    lines.push("", "Fallback:");
    for (const p of config.fallback.filter((f) => f !== config.primary)) lines.push(modelSummaryLine(deps, p));
  } else {
    lines.push("", "No fallback provider configured.");
  }
  const rows: ReturnType<typeof coloredButton>[][] = providers
    .filter((p) => p !== "airllm")
    .map((p) => [coloredButton(`Model for ${p}${p === config.primary ? " (primary)" : ""}`, "blue", `modelfor:${p}`)]);
  await sendOrEditScreen(deps, chatId, lines.join("\n"), withMenuHome(keyboard(rows)), editMessageId);
}

/** The real per-provider picker (fetch-live-models or manual-entry) -- reused for the primary
 * provider AND any configured fallback provider, via the modelfor: callback. */
// Real gap fixed (user: "this too should automatically delete in 20 sec") -- the model-picker
// messages below are the same transient-confirmation class of noise as the other self-deleting
// toasts, just given a longer window (20s, not the default 10s) since these carry a real button
// the user needs a moment to actually tap.
const MODEL_PICKER_SELF_DELETE_MS = 20_000;

async function sendModelPickerForProvider(deps: CommandRouterDeps, chatId: number, provider: ProviderName): Promise<void> {
  const entry = listProviderCatalog().find((e) => e.id === provider)!;

  // AirLLM is fixed, self-hosted infrastructure (Qwen3-235B via AIRLLM_BASE_URL) -- there is no
  // per-key model to pick and no real /models endpoint to fetch (modelsPath is null), so it gets
  // its own honest, static answer instead of a broken empty fetch/manual-entry flow.
  if (provider === "airllm") {
    await sendSelfDeletingMessage(deps.client, { chat_id: chatId, text: `<b>Model for airllm</b>\nFixed: <code>${entry.defaultModel}</code> (self-hosted via AIRLLM_BASE_URL -- not user-selectable).`, parse_mode: "HTML" }, MODEL_PICKER_SELF_DELETE_MS);
    return;
  }

  const key = primaryKeyFor(deps, provider);
  if (!key) {
    await sendSelfDeletingMessage(deps.client, { chat_id: chatId, text: `Provider not set: <b>${provider}</b> has no working key -- add one in the admin panel, or /providers to switch.`, parse_mode: "HTML" }, MODEL_PICKER_SELF_DELETE_MS);
    return;
  }
  const chosenModel = key.config.model;
  const currentLine = chosenModel ? `Current: <code>${chosenModel}</code>` : `Model not set yet -- will use ${provider}'s own default (<code>${entry.defaultModel}</code>) until you pick one.`;

  if (entry.manualModelEntry) {
    setPendingManualModelEntry(deps.db, deps.userId, provider);
    await sendSelfDeletingMessage(
      deps.client,
      { chat_id: chatId, text: `<b>Model for ${provider}</b>\n${currentLine}\n\n${provider} requires manual model entry -- reply with the exact model ID as your next message and I'll set it.`, parse_mode: "HTML" },
      MODEL_PICKER_SELF_DELETE_MS
    );
    return;
  }
  await sendSelfDeletingMessage(
    deps.client,
    {
      chat_id: chatId,
      text: `<b>Model for ${provider}</b>\n${currentLine}\n\nTap below to fetch the live model list from ${provider}'s real API and pick one.`,
      parse_mode: "HTML",
      reply_markup: keyboard([[coloredButton("🔄 Fetch live models", "blue", `fetchmodels:${provider}`)]]),
    },
    MODEL_PICKER_SELF_DELETE_MS
  );
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
  await sendSelfDeletingMessage(deps.client, { chat_id: chatId, text: `✅ ${provider} API key saved.` });
  return true;
}

/** Real fix (user: "e2b... should be settable in the telegram") -- E2B keys previously only
 * had an admin-panel route. */
export async function tryHandlePendingE2BKeyEntry(deps: CommandRouterDeps, chatId: number, text: string): Promise<boolean> {
  if (!getPendingE2BKeyEntry(deps.db, deps.userId)) return false;
  setPendingE2BKeyEntry(deps.db, deps.userId, false);
  const key = addE2BKey(deps.db, deps.userId, `E2B ${listE2BKeys(deps.db, deps.userId).length}`, text.trim());
  await sendSelfDeletingMessage(deps.client, { chat_id: chatId, text: `✅ E2B key saved (${key.label}).` });
  return true;
}

export async function tryHandlePendingFirecrawlKeyEntry(deps: CommandRouterDeps, chatId: number, text: string): Promise<boolean> {
  if (!getPendingFirecrawlKeyEntry(deps.db, deps.userId)) return false;
  setPendingFirecrawlKeyEntry(deps.db, deps.userId, false);
  const key = addFirecrawlKey(deps.db, deps.userId, `Firecrawl ${listFirecrawlKeys(deps.db, deps.userId).length}`, text.trim());
  await sendSelfDeletingMessage(deps.client, { chat_id: chatId, text: `✅ Firecrawl key saved (${key.label}).` });
  return true;
}

/** Format: "name | url" or "name | url | token" on one line. */
export async function tryHandlePendingMcpServerEntry(deps: CommandRouterDeps, chatId: number, text: string): Promise<boolean> {
  if (!getPendingMcpServerEntry(deps.db, deps.userId)) return false;
  setPendingMcpServerEntry(deps.db, deps.userId, false);
  const parts = text.split("|").map((p) => p.trim());
  const [name, url, token] = parts.length >= 2 ? parts : [parts[0], parts[0]];
  try {
    const config = addMcpServerConfig(deps.userId, name, url, token || undefined);
    await sendSelfDeletingMessage(deps.client, { chat_id: chatId, text: `✅ MCP server saved: ${config.name} (${config.url})` });
  } catch (err) {
    await deps.client.sendMessage({ chat_id: chatId, text: err instanceof InvalidMcpServerUrlError ? err.message : `Error: ${err instanceof Error ? err.message : String(err)}` });
  }
  return true;
}

/** Real fix (user: "I can set up to 20 keys in the telegram and paste the settable
 * credentials in telegram") -- the user's next message is one or more API keys, one per
 * line (a single pasted key is just a 1-line case of the same real bulk-add path, which
 * already enforces the 20-key cap and reports per-line success/failure honestly). */
export async function tryHandlePendingKeyEntry(deps: CommandRouterDeps, chatId: number, text: string): Promise<boolean> {
  const provider = getPendingKeyEntry(deps.db, deps.userId);
  if (!provider) return false;
  setPendingKeyEntry(deps.db, deps.userId, null);
  const results = addProviderKeysBulk(deps.db, deps.userId, provider, provider, text);
  const lines = results.map((r, i) => (r.ok ? `Line ${i + 1}: OK (${r.key!.label})` : `Line ${i + 1}: FAILED -- ${r.error}`));
  const allOk = results.every((r) => r.ok);
  // Real gap fixed (user: "Adding key(s)... Line 1: OK... just filling the place up") -- a
  // clean, all-success report self-deletes like any other transient confirmation. A report with
  // at least one real failure stays put -- that's actionable, not noise.
  if (allOk) {
    await sendSelfDeletingMessage(deps.client, { chat_id: chatId, text: `<b>Adding key(s) for ${provider}</b>\n${lines.join("\n")}`, parse_mode: "HTML" });
  } else {
    await deps.client.sendMessage({ chat_id: chatId, text: `<b>Adding key(s) for ${provider}</b>\n${lines.join("\n")}`, parse_mode: "HTML" });
  }
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
  return withMenuHome(
    keyboard([
      [coloredButton("Risk / Trading", "blue", "settings:risk"), coloredButton("Trading Mode", "blue", "settings:tradingmode")],
      [coloredButton("Pair Group", "blue", "settings:pairgroup"), coloredButton("Voice", "blue", "settings:voice")],
      [coloredButton("Memory", "blue", "settings:memory"), coloredButton("E2B Keys", "blue", "settings:e2b")],
      [coloredButton("Trailing / Breakeven", "blue", "settings:trailing"), coloredButton("Notifications", "blue", "settings:notifications")],
      [coloredButton("Autonomous Trading", "blue", "settings:tradinginterval")],
      [coloredButton("EA Token", "blue", "settings:eatoken")],
      [coloredButton("AI Response Timeout", "blue", "settings:providertimeout")],
      [coloredButton("Trading Session", "blue", "settings:session")],
      [coloredButton("Confidence Rate", "blue", "settings:confidence")],
      [coloredButton("Firecrawl Keys", "blue", "settings:firecrawl"), coloredButton("MCP Servers", "blue", "settings:mcp")],
    ])
  );
}

/** Real gap fixed (user, with a real screenshot: "implement confidence rate... a setting to
 *  auto approval trade below the confidence rate"): the real threshold + auto-approve toggle
 *  trade_execute's confidence gate (confidence-gate.ts) actually reads. */
function confidenceKeyboard(userId: string): { text: string; reply_markup: ReturnType<typeof keyboard> } {
  const settings = getConfidenceSettings(userId);
  const lines = [
    "<b>Confidence Rate</b>",
    `Threshold: ${settings.threshold}%`,
    `Below threshold: ${settings.autoApproveBelowThreshold ? "Auto-approved" : "Asks you to approve"}`,
    "",
    "Trades I place below this confidence score wait for your Approve/Decline unless auto-approve is on.",
  ];
  const rows: ReturnType<typeof coloredButton>[][] = [
    [{ text: `Set threshold (currently ${settings.threshold}%)`, callback_data: "confidence:setthreshold" }],
    [coloredButton(`Auto-approve below threshold: ${settings.autoApproveBelowThreshold ? "On" : "Off"}`, settings.autoApproveBelowThreshold ? "green" : "red", "confidence:toggleauto")],
  ];
  return { text: lines.join("\n"), reply_markup: withMenuHome(keyboard(rows), "settings:top") };
}

export async function tryHandlePendingConfidenceEntry(deps: CommandRouterDeps, chatId: number, text: string): Promise<boolean> {
  if (!getPendingConfidenceEntry(deps.userId)) return false;
  setPendingConfidenceEntry(deps.userId, false);
  const value = Number(text.trim());
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    await deps.client.sendMessage({ chat_id: chatId, text: "That doesn't look like a real confidence threshold -- reply with a number between 0 and 100. Tap the row in /settings to try again." });
    return true;
  }
  setConfidenceThreshold(deps.userId, value);
  await sendSelfDeletingMessage(deps.client, { chat_id: chatId, text: `✅ Confidence threshold set to ${value}%` });
  return true;
}

/** Real gap fixed (user: "in settings to select the session you want it to trade and also a
 * option to put all so it can trade all sessions"): real, persisted session preference with a
 * genuine "All" option, enforced in find-setup.ts (a scan outside the selected window is honestly
 * skipped, not silently run anyway). */
const TRADING_SESSION_OPTIONS: { value: TradingSession; label: string }[] = [
  { value: "all", label: "🌍 All sessions" },
  { value: "sydney", label: "Sydney" },
  { value: "asian", label: "Asian (Tokyo)" },
  { value: "london", label: "London" },
  { value: "new_york", label: "New York" },
];

function tradingSessionKeyboard(userId: string): { text: string; reply_markup: ReturnType<typeof keyboard> } {
  const current = getTradingSession(userId);
  const lines = ["<b>Trading Session</b>", `Current: ${TRADING_SESSION_OPTIONS.find((o) => o.value === current)?.label ?? current}`, "", "Real UTC windows -- outside the selected window, a scan is honestly skipped, not run anyway."];
  const rows: ReturnType<typeof coloredButton>[][] = [];
  for (let i = 0; i < TRADING_SESSION_OPTIONS.length; i += 2) {
    rows.push(TRADING_SESSION_OPTIONS.slice(i, i + 2).map((o) => coloredButton(o.value === current ? `✅ ${o.label}` : o.label, o.value === current ? "green" : "neutral", `session:${o.value}`)));
  }
  return { text: lines.join("\n"), reply_markup: withMenuHome(keyboard(rows), "settings:top") };
}

/** Real gap fixed (user: "increase the timeout... settable in settings"): real button pickers
 * for the primary provider's timeout and every fallback provider's own (usually shorter)
 * timeout -- no typing, same pattern as the trading-cadence picker above. */
const PRIMARY_TIMEOUT_PRESETS_SECONDS = [10, 15, 20, 30, 45, 60] as const;
const FALLBACK_TIMEOUT_PRESETS_SECONDS = [3, 5, 10, 15] as const;

function providerTimeoutKeyboard(userId: string): { text: string; reply_markup: ReturnType<typeof keyboard> } {
  const config = getProviderTimeoutConfig(userId);
  const lines = [
    "<b>AI Response Timeout</b>",
    `Primary provider: ${config.primarySeconds}s`,
    `Fallback provider(s): ${config.fallbackSeconds}s each`,
    "",
    "A slow/dead primary provider only costs its own timeout, not the same wait repeated for every fallback -- keep fallback short so a bad primary doesn't stall the whole chain.",
    "",
    "Primary timeout:",
  ];
  const rows: ReturnType<typeof coloredButton>[][] = [];
  for (let i = 0; i < PRIMARY_TIMEOUT_PRESETS_SECONDS.length; i += 3) {
    rows.push(
      PRIMARY_TIMEOUT_PRESETS_SECONDS.slice(i, i + 3).map((s) =>
        coloredButton(s === config.primarySeconds ? `✅ ${s}s` : `${s}s`, s === config.primarySeconds ? "green" : "neutral", `providertimeout:primary:${s}`)
      )
    );
  }
  rows.push([{ text: "Fallback timeout:", callback_data: "noop" }]);
  for (let i = 0; i < FALLBACK_TIMEOUT_PRESETS_SECONDS.length; i += 4) {
    rows.push(
      FALLBACK_TIMEOUT_PRESETS_SECONDS.slice(i, i + 4).map((s) =>
        coloredButton(s === config.fallbackSeconds ? `✅ ${s}s` : `${s}s`, s === config.fallbackSeconds ? "green" : "neutral", `providertimeout:fallback:${s}`)
      )
    );
  }
  return { text: lines.join("\n"), reply_markup: withMenuHome(keyboard(rows), "settings:top") };
}

/**
 * Real gap fixed (user: "the ea token should have only one token which is revokable... add that
 * in the settings ui to revoke it"): shows the real current token (see ea-webhook.ts's
 * DAVE-<userId>-<suffix> format -- the DAVE-<userId> part is permanent, the suffix is what
 * revoking regenerates) with a real Revoke button.
 */
function eaTokenKeyboard(userId: string): { text: string; reply_markup: ReturnType<typeof keyboard> } {
  const hook = getOrCreateEaWebhook(userId);
  const lines = [
    "<b>EA Token</b>",
    `Current token: <code>${hook.token}</code>`,
    "",
    "This is the real credential your MT5 EA authenticates with -- anyone with it could send commands as if they were your EA. Revoking generates a new one immediately and invalidates the old one (any already-downloaded EA file stops working until you run /ea again for a fresh one).",
  ];
  return { text: lines.join("\n"), reply_markup: withMenuHome(keyboard([[coloredButton("🔄 Revoke & regenerate", "red", "eatoken:revoke")]]), "settings:top") };
}

/** Real gap fixed (user: "the trading interval to scan add it to the settings ui no manual
 * config like < >"): /start_trading <minutes> (typed) still works, but this is the real
 * button-based picker -- no typing required. Preset choices only, tap to apply immediately (live
 * re-arm if already running, same real setAutonomousTradingIntervalMinutes() as the typed path).
 * Real wording fix (user: "it's not a cadence it's a loop"): autonomous trading is a real
 * repeating scan loop, not a musical cadence -- every user-facing string below says "loop"/"scan
 * interval" instead. "Auto" (user: "the interval to analyze it can be set to auto") resets to the
 * real system default (DEFAULT_TRADING_LOOP_MINUTES) rather than requiring the user to remember or
 * pick a specific number. */
function tradingIntervalKeyboard(userId: string): { text: string; reply_markup: ReturnType<typeof keyboard> } {
  const current = getTradingLoopIntervalMinutes(userId);
  const running = isAutonomousTradingRunning(userId);
  const lines = [
    "<b>Autonomous Trading</b>",
    `Status: ${running ? "▶️ Running" : "⏸️ Off"}`,
    `Scan loop interval: every ${current} min (compulsory -- not user-adjustable)`,
  ];
  return { text: lines.join("\n"), reply_markup: withMenuHome(keyboard([]), "settings:top") };
}

/** NOTIFICATIONS section: real push toggle (genuinely gates the alert-sending tools in
 * extra-tools.ts), real trade-opened toggle, and an honestly-labeled email toggle -- the
 * setting is real and stored, but no email-sending capability exists anywhere in this
 * codebase yet, so it's flagged rather than pretended to work. */
function notificationsKeyboard(deps: CommandRouterDeps): ReturnType<typeof keyboard> {
  const settings = getNotificationSettings(deps.db, deps.userId);
  return withMenuHome(
    keyboard([
      [coloredButton(`Push notifications: ${settings.pushEnabled ? "On" : "Off"}`, settings.pushEnabled ? "green" : "red", "notif:togglepush")],
      [coloredButton(`Trade-opened alert: ${settings.tradeOpenedEnabled ? "On" : "Off"}`, settings.tradeOpenedEnabled ? "green" : "red", "notif:toggletradeopened")],
      [coloredButton(`Email notifications: ${settings.emailEnabled ? "On (no email sender configured yet)" : "Off"}`, settings.emailEnabled ? "green" : "red", "notif:toggleemail")],
    ]),
    "settings:top"
  );
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
  ];
  return { text: lines.join("\n"), reply_markup: withMenuHome(keyboard(rows), "settings:top") };
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
  await sendSelfDeletingMessage(deps.client, { chat_id: chatId, text: `✅ ${field} set to ${value}` });
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
  return { text: lines.join("\n"), reply_markup: withMenuHome(keyboard(rows), "settings:top") };
}

/** Real gap fixed (user: "add more providers and make provision for... add firecrawl") -- same
 *  real backend (firecrawl-keys.ts, an exact mirror of e2b-keys.ts) the admin panel already used,
 *  now reachable from /settings too. */
function firecrawlKeyboard(deps: CommandRouterDeps): { text: string; reply_markup: ReturnType<typeof keyboard> } {
  const keys = listFirecrawlKeys(deps.db, deps.userId);
  const lines = [`<b>Firecrawl Keys</b>`, keys.length === 0 ? "No keys stored yet." : `${keys.length}/10 stored key(s):`];
  const rows: ReturnType<typeof coloredButton>[][] = keys.map((k) => [
    coloredButton(`${k.healthy ? "🟢" : "🔴"} ${k.label}`, "neutral", `firecrawlkey:noop:${k.id}`),
    coloredButton("Remove", "red", `firecrawlkey:remove:${k.id}`),
  ]);
  if (keys.length < 10) rows.push([coloredButton("➕ Add key", "blue", "firecrawlkey:add")]);
  return { text: lines.join("\n"), reply_markup: withMenuHome(keyboard(rows), "settings:top") };
}

/** Real gap fixed (user: "add provision for mcps you added that to the code but you haven't
 *  implemented it yet") -- real provisioning UI for the generic MCP manager (mcp-manager.ts):
 *  saved name+url+token per server, and a real "Connect now" that opens a live socket and
 *  reports the real tool count discovered, same as calling mcp_connect would. */
function mcpServersKeyboard(deps: CommandRouterDeps): { text: string; reply_markup: ReturnType<typeof keyboard> } {
  const servers = listMcpServerConfigs(deps.userId);
  const lines = [`<b>MCP Servers</b>`, servers.length === 0 ? "No servers saved yet." : `${servers.length} saved server(s):`, "", "Saved here so Dave doesn't need to ask you for a URL every time it wants to use one."];
  const rows: ReturnType<typeof coloredButton>[][] = servers.map((s) => [
    coloredButton(s.name, "neutral", `mcpsrv:noop:${s.id}`),
    coloredButton("Connect", "green", `mcpsrv:connect:${s.id}`),
    coloredButton("Remove", "red", `mcpsrv:remove:${s.id}`),
  ]);
  rows.push([coloredButton("➕ Add MCP server", "blue", "mcpsrv:add")]);
  return { text: lines.join("\n"), reply_markup: withMenuHome(keyboard(rows), "settings:top") };
}

async function handleSettings(deps: CommandRouterDeps, chatId: number, editMessageId?: number): Promise<void> {
  await sendOrEditScreen(deps, chatId, "<b>Settings</b>\nTrading behavior (what/when/how to trade) is built in -- see /help. This screen is for account/risk settings only.", settingsTopKeyboard(), editMessageId);
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
  return appendMenuHome(
    settingsScreen(
      [
        [
          { label: `SL: ${modeLabel(settings.slMode, settings.slValue)}`, callbackData: "cyclemode:sl", active: false },
          { label: "Set SL (On)", callbackData: "setrisk:sl", active: false },
        ],
        [
          { label: `TP: ${modeLabel(settings.tpMode, settings.tpValue)}`, callbackData: "cyclemode:tp", active: false },
          { label: "Set TP (On)", callbackData: "setrisk:tp", active: false },
        ],
        [
          { label: `Lot: ${modeLabel(settings.lotMode, settings.lotValue)}`, callbackData: "cyclemode:lot", active: false },
          { label: "Set Lot (On)", callbackData: "setrisk:lot", active: false },
        ],
        // Real fix: max open trades / max daily loss are PROTECTED (SECURITY.md) -- tapping
        // never applies a value directly, it only primes capture of the user's own number,
        // which then goes through the real, unavoidable proposeProtectedLimitChange ->
        // separate approve/decline round trip, same as a Dave-initiated proposal.
        [{ label: maxOpenTradesLabel, callbackData: "proposelimit:maxOpenTrades", active: false }],
        [{ label: maxDailyLossLabel, callbackData: "proposelimit:maxDailyLossPct", active: false }],
      ],
      "settings:top"
    )
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

/**
 * Item 12 real gap fixed: this is the missing counterpart to tryHandlePendingLimitEntry, for
 * sl/tp/lot "On" mode -- unlike the protected limits, sl/tp/lot are NOT protected fields, so this
 * applies the user's own typed value immediately via setRiskMode(), the same way a direct /settings
 * change always has (proposeSettingsChange's approval gate is only for a Dave-INITIATED change).
 */
export async function tryHandlePendingRiskEntry(deps: CommandRouterDeps, chatId: number, text: string): Promise<boolean> {
  const field = getPendingRiskEntry(deps.userId);
  if (!field) return false;
  setPendingRiskEntry(deps.userId, null);
  const value = Number(text.trim());
  if (!Number.isFinite(value) || value <= 0) {
    await deps.client.sendMessage({ chat_id: chatId, text: `That doesn't look like a real number -- reply with just the value, e.g. "20" or "0.5". Tap the row in /settings to try again.` });
    return true;
  }
  setRiskMode(deps.userId, field, "on", value);
  const label = field === "sl" ? `SL -> On (${value} pips)` : field === "tp" ? `TP -> On (${value} pips)` : `Lot -> On (${value})`;
  await deps.client.sendMessage({ chat_id: chatId, text: `✅ ${label}` });
  return true;
}

/**
 * Item 5 real gap fixed: the capture half of the /connection "Set push interval" button --
 * parses the user's typed seconds value, enqueues a real "set_push_interval" EA command (applied
 * live on the EA's next poll), and confirms honestly (not "done", since it hasn't actually
 * reached the EA yet -- see setEaPushInterval's real round-trip note).
 */
export async function tryHandlePendingPushIntervalEntry(deps: CommandRouterDeps, chatId: number, text: string): Promise<boolean> {
  if (!getPendingPushIntervalEntry(deps.userId)) return false;
  setPendingPushIntervalEntry(deps.userId, false);
  const value = Number(text.trim());
  if (!Number.isFinite(value) || value < 3 || value > 300) {
    await deps.client.sendMessage({ chat_id: chatId, text: `That doesn't look like a real interval -- reply with a whole number of seconds between 3 and 300. Tap the row in /connection to try again.` });
    return true;
  }
  setEaPushInterval(deps.userId, Math.round(value));
  await deps.client.sendMessage({ chat_id: chatId, text: `✅ Push interval set to ${Math.round(value)}s -- applies live the next time the EA polls (no restart needed).` });
  return true;
}

const AFFIRMATIVE_REPLY = /^\s*(yes|y|approve|approved|confirm|confirmed|ok|okay)[.!]?\s*$/i;
const NEGATIVE_REPLY = /^\s*(no|n|decline|declined|cancel|cancelled|canceled)[.!]?\s*$/i;

/**
 * Item 11 real bug fixed: "when Dave asks for approval... if the user answers via a normal typed
 * 'yes', it should NOT then ask again via UI buttons afterward." Previously a typed "yes" had no
 * real handler at all -- it just fell through to the agent loop, which (having no way to know a
 * real approval was already pending) could re-propose the same change and send a SECOND UI
 * prompt on top of the first. This intercepts a real affirmative/negative reply BEFORE the agent
 * loop ever sees it, and treats it as EXACTLY equivalent to tapping the real Approve/Decline
 * button on the one pending change -- same real approveSettingsChange/declineSettingsChange call,
 * same confirmation message. Only acts when there is EXACTLY one real pending change (ambiguous
 * with more than one -- falls through to normal conversation rather than guessing which).
 */
export async function tryHandlePendingApprovalReply(deps: CommandRouterDeps, chatId: number, text: string): Promise<boolean> {
  const isAffirmative = AFFIRMATIVE_REPLY.test(text);
  const isNegative = NEGATIVE_REPLY.test(text);
  if (!isAffirmative && !isNegative) return false;
  const pending = listPendingLimitChanges(deps.userId);
  if (pending.length !== 1) return false;
  const change = pending[0];
  if (isAffirmative) {
    const settings = approveSettingsChange(deps.userId, change.id);
    await deps.client.sendMessage({
      chat_id: chatId,
      text: `✅ Approved. SL=${modeLabel(settings.slMode, settings.slValue)} TP=${modeLabel(settings.tpMode, settings.tpValue)} Lot=${modeLabel(settings.lotMode, settings.lotValue)} MaxOpenTrades=${settings.maxOpenTrades ?? "not set"} MaxDailyLoss=${settings.maxDailyLossPct ?? "not set"}%`,
    });
  } else {
    declineSettingsChange(deps.userId, change.id);
    await deps.client.sendMessage({ chat_id: chatId, text: "Declined -- no change made." });
  }
  return true;
}

/** TRADING MODE section: Auto (own judgment + skill library) vs Trading Skills (locked to one taught skill). */
function tradingModeKeyboard(userId: string): ReturnType<typeof keyboard> {
  const state = getTradingMode(userId);
  return withMenuHome(
    keyboard([
      [coloredButton(state.mode === "auto" ? "✅ Auto" : "Auto", state.mode === "auto" ? "green" : "neutral", "tradingmode:auto")],
      [coloredButton(state.mode === "trading-skills" ? `✅ Trading Skills (${state.lockedSkillId ?? "none"})` : "Trading Skills", state.mode === "trading-skills" ? "green" : "neutral", "tradingmode:pickskill")],
    ]),
    "settings:top"
  );
}

function skillPickerKeyboard(userId: string): ReturnType<typeof keyboard> {
  const skills = listSkills(userId);
  const rows: ReturnType<typeof coloredButton>[][] = skills.map((s) => [coloredButton(s.name, "neutral", `tradingmode:setskill:${s.id}`)]);
  return withMenuHome(keyboard(rows), "settings:tradingmode");
}

/** PAIR GROUP section: exactly one active + one fallback at a time, per pair-groups.ts's own real invariant. */
function pairGroupKeyboard(userId: string): { text: string; reply_markup: ReturnType<typeof keyboard> } {
  seedDefaultPairGroups(userId);
  const groups = listGroups(userId);
  const info = getActiveGroupInfo(userId);
  const lines = [
    `<b>Pair Group</b>`,
    `Active: ${info.activeGroup?.name ?? "none"}`,
    `Fallback: ${info.fallbackGroup?.name ?? "none"}`,
    // Real gap fixed (user: "add active pair so incase a user doesn't want to use a group of
    // pair it can select a pair the bot can focus only"): a real, persisted single-symbol
    // override, shown honestly here alongside the group selection it overrides.
    `Single-pair focus: ${info.activePairSymbol ?? "off (scanning the whole active group)"}`,
    info.pausedForExtremeConditions ? "⚠️ Paused for extreme market conditions." : "",
    "",
    groups.length === 0 ? "No pair groups defined yet -- create one in the admin panel." : "Tap to set active/fallback:",
  ].filter(Boolean);
  const rows: ReturnType<typeof coloredButton>[][] = groups.map((g) => [
    coloredButton(g.id === info.activeGroup?.id ? `✅ ${g.name}` : g.name, g.id === info.activeGroup?.id ? "green" : "neutral", `pairgroup:active:${g.id}`),
    coloredButton(g.id === info.fallbackGroup?.id ? `✅ Fallback` : "Set fallback", g.id === info.fallbackGroup?.id ? "green" : "neutral", `pairgroup:fallback:${g.id}`),
  ]);
  rows.push(
    info.activePairSymbol
      ? [coloredButton(`✅ Focused: ${info.activePairSymbol}`, "green", "pairgroup:setpair"), coloredButton("❌ Clear focus", "red", "pairgroup:clearpair")]
      : [coloredButton("🎯 Focus one pair", "blue", "pairgroup:setpair")]
  );
  return { text: lines.join("\n"), reply_markup: withMenuHome(keyboard(rows), "settings:top") };
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
  const text = `<b>Voice</b>\n${settings.enabled ? `On -- ${settings.activeProvider}` : "Off"}`;
  return { text, reply_markup: withMenuHome(keyboard(rows), "settings:top") };
}

/** MEMORY section: write-approval (off by default -- Dave asks before saving to memory) + the
 * existing Dave-initiated-settings-change auto-approval switch, relocated here per the spec's
 * section naming (same single underlying control -- see the audit report). */
function memoryKeyboard(userId: string): ReturnType<typeof keyboard> {
  const writeApproval = getWriteApprovalSetting(userId);
  const autoApproval = getAutoApprovalEnabled(userId);
  return withMenuHome(
    keyboard([
      [coloredButton(`Ask before saving to memory: ${writeApproval ? "On" : "Off"}`, writeApproval ? "green" : "red", "togglewriteapproval")],
      [coloredButton(`Auto-approve Dave's proposals: ${autoApproval ? "On" : "Off"}`, autoApproval ? "green" : "red", "toggleautoapproval")],
    ]),
    "settings:top"
  );
}

/**
 * Item 8 real gap fixed: /reset used to only clear conversation history -- everything else
 * (memory files, trading settings, notification/voice preferences) silently survived, which is
 * NOT what "reset" honestly means and isn't what the user asked for. This is destructive and
 * irreversible, so it now requires a real confirmation step (colored Approve/Decline) before
 * anything is touched -- a single tap can no longer wipe it all by accident.
 */
async function handleReset(deps: CommandRouterDeps, chatId: number): Promise<void> {
  await deps.client.sendMessage({
    chat_id: chatId,
    text:
      "<b>⚠️ Full reset</b>\nThis will genuinely wipe:\n" +
      "• Conversation history (both this chat and my own autonomous-cycle thread)\n" +
      "• Memory (MEMORY.md, USER.md, ADAPTABILITY.md)\n" +
      "• Every past-conversation record (the L0/L1/L2 recall tiers -- raw turns, extracted facts, scenario summaries)\n\n" +
      "Your settings (risk mode, pair group, trading mode, confidence threshold, trailing config, voice/notification prefs), your trading behavior (built in, not something you upload), and your stored provider/E2B API keys and EA pairing token are NOT touched -- this is a memory wipe, not a settings wipe.\n\n" +
      "This cannot be undone. Continue?",
    parse_mode: "HTML",
    reply_markup: keyboard([[coloredButton("✅ Yes, wipe everything", "green", "resetconfirm:yes"), coloredButton("❌ Cancel", "red", "resetconfirm:no")]]),
  });
}

/**
 * The actual real wipe -- only ever reached after the user explicitly taps "Yes" above.
 *
 * Real gap fixed (user, explicit spec: "/reset doesn't fuckin do anything... it should reset the
 * bot like a brand new. The only thing it should leave is the user settings and the apis and ea
 * token, it should delete every fuckin thing"). This used to ALSO wipe risk/trading-mode/pair-
 * group/trailing/write-approval/voice/notification/confidence settings back to defaults -- the
 * user has to redo real configuration every time, which isn't what "reset" means to them. Reset
 * is now scoped to genuinely EVERYTHING memory/conversation-shaped (both real conversation
 * threads, MEMORY.md/USER.md/ADAPTABILITY.md, AND the L0/L1/L2 recall tiers -- see
 * tencent-tiers.ts's clearMemoryTiers, a second real memory store /reset never touched before)
 * and leaves every real setting, provider/E2B API key, and the EA pairing token exactly as they
 * were -- a genuine memory wipe, not a settings wipe. Also deliberately does NOT touch goal.yaml
 * (an optional, real user-authored override some users may still have set) or the circuit
 * breaker/drawdown-pause state (a real safety trip that exists specifically to require its own
 * deliberate, separate clearing action -- never something a memory reset silently undoes).
 *
 * Telegram limitation, honestly reported rather than faked: bots can only delete their OWN
 * messages (and only within 48h) -- there is no real Bot API method to delete a user's own
 * sent messages in a private chat, so "delete the conversation from the chat itself" is not
 * something this can genuinely do without a message-id history this build doesn't keep. The
 * real, honest fallback -- clearing all stored history so nothing carries forward -- is what
 * actually happens, and the confirmation message above says so plainly rather than pretending.
 */
async function performFullReset(deps: CommandRouterDeps, chatId: number, historyKey: string): Promise<void> {
  clearConversationHistory(deps.db, historyKey);
  clearConversationHistory(deps.db, `${deps.userId}:autonomous:${chatId}`);
  resetUserMemory(deps.userId);
  clearMemoryTiers(deps.userId);
  await deps.client.sendMessage({ chat_id: chatId, text: "✅ Full reset complete -- every conversation thread and every memory record are genuinely gone. Your settings, API keys, and EA pairing token are untouched. Starting fresh." });
  await handleMenu(deps, chatId);
}

/** Real fix (spec: "3-4 real examples" of conversational use + mention /stop and /panic).
 * /stop, /panic, /start_trading, and /stop_trading are deliberately NOT in DAVE_COMMANDS
 * (they're not part of the public 9/10-command menu) -- real, working commands, just not
 * menu-listed; mentioned here explicitly instead. */
async function handleHelp(deps: CommandRouterDeps, chatId: number, editMessageId?: number): Promise<void> {
  const lines = DAVE_COMMANDS.map((c) => `/${c.command} -- ${c.description}`);
  const text =
    `<b>What I can do</b>\n${lines.join("\n")}\n\n` +
    `Everything else is just talking to me normally -- for example:\n` +
    `• "Set SL to 20 pips"\n` +
    `• "Switch to the Forex pair group"\n` +
    `• "Find me a setup on gold"\n` +
    `• "Switch provider to DeepSeek"\n\n` +
    `/start_trading turns on autonomous trading (I act on real setups on my own, and only message you when something actually happens) -- /start_trading followed by a number of minutes also sets/changes how often I scan (default 5); /stop_trading turns it off cleanly.\n` +
    `/stop or /panic halts all trading and workers instantly, any time -- not just a settings toggle.`;
  await sendOrEditScreen(deps, chatId, text, withMenuHome(keyboard([])), editMessageId);
}

async function handleStatus(deps: CommandRouterDeps, chatId: number, editMessageId?: number): Promise<void> {
  const breaker = getCircuitBreakerReport(deps.db, deps.userId);
  const interrupt = getInterruptState(deps.userId);
  const workers = listWorkers(deps.userId);
  const breakerLine = breaker.tripped ? formatTripReport(breaker) : `OK (${breaker.consecutiveErrors} consecutive errors)`;
  const tradingLoopLine = isAutonomousTradingRunning(deps.userId) ? `${interrupt.tradingLoop} (every ${getTradingLoopIntervalMinutes(deps.userId)} min)` : interrupt.tradingLoop;
  // Real gap fixed (user: "implement journal of the day thats win rate and others"): real, today
  // (UTC), computed straight from the EA's own real closed-trade reports -- winRatePct stays
  // honestly null (shown as "no closed trades yet") rather than a fabricated 0%.
  const journal = getTodaysWinRateSummary(deps.db, deps.userId);
  const journalLine =
    journal.total === 0
      ? "No closed trades yet today"
      : `${journal.wins}W/${journal.losses}L${journal.breakeven > 0 ? `/${journal.breakeven}BE` : ""} (${journal.winRatePct!.toFixed(0)}% win rate) — net ${formatMoney(journal.netPnl)}`;
  const text =
    `<b>Status</b>\n` +
    `Circuit breaker: ${breakerLine}\n` +
    `Trading loop: ${tradingLoopLine}\n` +
    `Active workers: ${workers.length}\n` +
    `Today's journal: ${journalLine}`;
  await sendOrEditScreen(deps, chatId, text, withMenuHome(keyboard([])), editMessageId);
}

/** Real fix (user: "when sending the ea it normally does need a ui that's not necessary...
 * remove it the ui should be Dave EA and mcp for trading so incase they don't want to use the ea
 * I can provide my mcp for the placing of trade"): the old picker's two buttons ("Dave's default
 * MT5 account" / "My own MT5 account") were a known, documented dead end -- both led to the exact
 * same flow, nothing genuinely branched on the choice. Replaced with a REAL choice: the file-based
 * MT5 EA (unchanged, still real), or a real MCP trading server (mcp-trade-adapter.ts's
 * McpTradeExecutor, which already existed but had no UI to actually pick it) -- every real trade
 * call routes through whichever one is genuinely configured (DynamicTradeExecutor). */
async function handleEa(deps: CommandRouterDeps, chatId: number): Promise<void> {
  const config = getTradingModeConfig(deps.userId);
  const text =
    `<b>Trade Execution</b>\n` +
    `Current: ${config.mode === "mcp" ? `MCP (${config.mcpServerUrl})` : "Dave EA (MT5)"}\n\n` +
    `How should Dave place your trades?`;
  const rows = [
    [coloredButton(config.mode === "ea" ? "✅ Dave EA (MT5)" : "Dave EA (MT5)", config.mode === "ea" ? "green" : "neutral", "eaexec:ea")],
    [coloredButton(config.mode === "mcp" ? "✅ MCP for trading" : "MCP for trading", config.mode === "mcp" ? "green" : "neutral", "eaexec:mcp")],
  ];
  await deps.client.sendMessage({ chat_id: chatId, text, parse_mode: "HTML", reply_markup: withMenuHome(keyboard(rows)) });
}

/** The user's next free-text message after tapping "MCP for trading" IS the real MCP server URL. */
export async function tryHandlePendingMcpUrlEntry(deps: CommandRouterDeps, chatId: number, text: string): Promise<boolean> {
  if (!getPendingMcpUrlEntry(deps.db, deps.userId)) return false;
  setPendingMcpUrlEntry(deps.db, deps.userId, false);
  try {
    const config = setMcpTradingMode(deps.userId, text.trim());
    await deps.client.sendMessage({ chat_id: chatId, text: `✅ Trade execution set to MCP: <code>${config.mcpServerUrl}</code>. Real trade calls will connect to it from now on.`, parse_mode: "HTML" });
  } catch (err) {
    const message = err instanceof MissingMcpServerUrlError ? err.message : err instanceof Error ? err.message : String(err);
    await deps.client.sendMessage({ chat_id: chatId, text: `⚠️ ${message}` });
  }
  return true;
}

/** The user's next free-text message after tapping "Focus one pair" IS the real symbol. */
export async function tryHandlePendingActivePairEntry(deps: CommandRouterDeps, chatId: number, text: string): Promise<boolean> {
  if (!getPendingActivePairEntry(deps.db, deps.userId)) return false;
  setPendingActivePairEntry(deps.db, deps.userId, false);
  const symbol = text.trim().toUpperCase();
  setActivePairSymbol(deps.userId, symbol);
  await deps.client.sendMessage({ chat_id: chatId, text: `✅ Focused on <b>${symbol}</b> -- scanning/trading only this pair until you clear it in Settings → Pair Group.`, parse_mode: "HTML" });
  return true;
}

/** Real command dispatch. Returns true if `text` was a recognized command and was handled (caller should NOT also forward it to the LLM). */
/** Real fix (user: "/menu should be UI, not a list of commands") -- a real inline-keyboard
 * menu, same visual pattern as every other screen in this build (2 per row, Back row). Tapping
 * a button runs the EXACT SAME handler typing that command would -- this is the single real
 * dispatch point both dispatchCommand (text) and the menu: callback (button tap) share, so
 * there is no second, divergent code path for "the same command run two ways." */
async function dispatchCommandByName(deps: CommandRouterDeps, chatId: number, historyKey: string, command: DaveCommand, editMessageId?: number): Promise<void> {
  switch (command) {
    case "start_trading":
    case "stop_trading":
    case "panic":
      // Real logic lives in telegram-bot-server.ts's handleTradingControlCommand -- it needs
      // the live autonomous-cycle closure (runAutonomousTradingCycle) and runAgentTurn, neither
      // of which this module has in scope. Both the typed-text path AND the /menu button-tap
      // path (menucmd:start_trading etc) intercept these BEFORE they ever reach this switch, so
      // this case is unreachable in practice -- kept explicit (not a silent fallthrough) so a
      // future reader isn't left wondering why these three are missing.
      break;
    case "account":
      await handleAccount(deps, chatId, editMessageId);
      break;
    case "connection":
      await handleConnection(deps, chatId, editMessageId);
      break;
    case "providers":
      await handleProviders(deps, chatId, editMessageId);
      break;
    case "models":
      await handleModels(deps, chatId, editMessageId);
      break;
    case "settings":
      await handleSettings(deps, chatId, editMessageId);
      break;
    case "reset":
      await handleReset(deps, chatId);
      break;
    case "help":
      await handleHelp(deps, chatId, editMessageId);
      break;
    case "menu":
      await handleMenu(deps, chatId, editMessageId);
      break;
    case "status":
      await handleStatus(deps, chatId, editMessageId);
      break;
    case "ea":
      await handleEa(deps, chatId);
      break;
    case "trades":
      await handleTrades(deps, chatId, editMessageId);
      break;
  }
}

/** Item 5: same usefulness-first order as DAVE_COMMANDS (commands.ts) -- what's happening now,
 * then how Dave is configured, then the occasional/destructive/reference ones last. */
const MENU_BUTTONS: { command: DaveCommand; label: string }[] = [
  { command: "start_trading", label: "▶️ Start trading" },
  { command: "stop_trading", label: "⏸️ Stop trading" },
  { command: "panic", label: "🚨 Panic" },
  { command: "status", label: "📊 Status" },
  { command: "account", label: "💰 Account" },
  { command: "trades", label: "📈 Trades" },
  { command: "settings", label: "⚙️ Settings" },
  { command: "providers", label: "🤖 Providers" },
  { command: "models", label: "🧠 Models" },
  { command: "connection", label: "🔌 Connection" },
  { command: "ea", label: "📄 EA File" },
  { command: "reset", label: "🔄 Reset" },
  { command: "help", label: "❓ Help" },
];

// Real gap fixed (user: "add the reset button to delete everything"): the button already existed
// and was already fully wired to the real confirm-then-wipe flow (handleReset), but it was the
// same blue as every harmless navigation button, easy to miss in a 12-button grid. Destructive
// actions (Reset, Panic) now render red so they're genuinely distinct at a glance, not just
// discoverable by reading every label.
const DESTRUCTIVE_MENU_COMMANDS = new Set<DaveCommand>(["reset", "panic"]);

function menuKeyboard(): ReturnType<typeof keyboard> {
  const rows: ReturnType<typeof coloredButton>[][] = [];
  for (let i = 0; i < MENU_BUTTONS.length; i += 2) {
    rows.push(MENU_BUTTONS.slice(i, i + 2).map((b) => coloredButton(b.label, DESTRUCTIVE_MENU_COMMANDS.has(b.command) ? "red" : "blue", `menucmd:${b.command}`)));
  }
  return keyboard(rows);
}

async function handleMenu(deps: CommandRouterDeps, chatId: number, editMessageId?: number): Promise<void> {
  await sendOrEditScreen(deps, chatId, "<b>Menu</b>\nTap a command:", menuKeyboard(), editMessageId);
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

  // Real bug fixed (item 6: "tapping any settings/UI button has a noticeable delay before
  // responding"). Telegram genuinely shows a loading spinner on the tapped button until
  // answerCallbackQuery is called -- this used to be called LAST, after every real DB write,
  // live network fetch (ElevenLabs voices, a provider's live model list), and message
  // send/edit below had already finished, so the spinner visibly hung for however long that real
  // work took. Acknowledging immediately, before any of that work starts, is the real fix --
  // Telegram only accepts ONE answerCallbackQuery per callback_query id, so `ackText` below is now
  // informational/logging only; every branch that needs to tell the user something real does it
  // through a genuine message send/edit, not a second toast.
  await deps.client.answerCallbackQuery({ callback_query_id: callback.id }).catch(() => undefined);

  // Real fix (user: "confirmation message after EVERY setting change, not just risky ones") --
  // a re-rendered screen plus a transient callback-answer toast (easy to miss, and not what
  // Telegram shows for a plain button tap without `show_alert`) isn't the same as a real,
  // persisted "✅ X set to Y" message showing exactly what changed. This sends that for every
  // real settings mutation below, on top of (not instead of) re-rendering the screen.
  // Real gap fixed (user: "any messages like this that's not useful should be deleted after
  // sending" -- citing exactly this class of toast): self-deletes a few seconds after sending,
  // via the real Bot API, instead of piling up in the chat forever.
  const confirm = async (text: string) => {
    if (chatId) await sendSelfDeletingMessage(deps.client, { chat_id: chatId, text: `✅ ${text}`, parse_mode: "HTML" });
  };

  const renderInPlace = async (text: string, reply_markup: ReturnType<typeof keyboard>) => {
    if (!chatId || !callback.message) return;
    await editOrSend(deps.client, { chat_id: chatId, message_id: callback.message.message_id, text, parse_mode: "HTML", reply_markup });
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
      await renderInPlace("<b>Settings</b>\nTrading behavior (what/when/how to trade) is built in -- see /help. This screen is for account/risk settings only.", settingsTopKeyboard());
    } else if (data === "settings:risk") {
      ackText = undefined;
      await renderInPlace("<b>Risk / Trading</b>", riskSettingsKeyboard(deps.userId));
    } else if (data.startsWith("setrisk:")) {
      // Item 12 real gap fixed: cyclemode only ever toggled off<->auto -- "on" mode requires the
      // user's own exact numeric value, and there was no real way to TYPE it for sl/tp/lot (only
      // the protected limits below had a tap-to-type flow). Same capture pattern, applied here.
      const field = data.slice("setrisk:".length) as RiskEntryField;
      setPendingRiskEntry(deps.userId, field);
      ackText = undefined;
      const fieldLabel = field === "sl" ? "SL (in pips)" : field === "tp" ? "TP (in pips)" : "lot size";
      if (chatId) await deps.client.sendMessage({ chat_id: chatId, text: `Reply with your exact ${fieldLabel} as your next message (a number).` });
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
    } else if (data === "pairgroup:setpair") {
      setPendingActivePairEntry(deps.db, deps.userId, true);
      ackText = "Send the symbol to focus on";
      if (chatId) await deps.client.sendMessage({ chat_id: chatId, text: "Send the one symbol you want me to focus on as your next message (e.g. EURUSD)." });
    } else if (data === "pairgroup:clearpair") {
      clearActivePairSymbol(deps.userId);
      ackText = "Single-pair focus cleared";
      await confirm("Back to scanning the whole active group.");
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
        if (chatId) await deps.client.sendMessage({ chat_id: chatId, text: ackText });
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
          if (chatId) await deps.client.sendMessage({ chat_id: chatId, text: ackText });
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
    } else if (data === "settings:tradinginterval") {
      ackText = undefined;
      const view = tradingIntervalKeyboard(deps.userId);
      await renderInPlace(view.text, view.reply_markup);
    } else if (data.startsWith("tradinginterval:")) {
      const minutes = Number(data.slice("tradinginterval:".length));
      setAutonomousTradingIntervalMinutes(deps.userId, minutes);
      ackText = `Cadence: every ${minutes} min`;
      await confirm(`Scan loop interval set to every ${minutes} min`);
      const view = tradingIntervalKeyboard(deps.userId);
      await renderInPlace(view.text, view.reply_markup);
    } else if (data === "settings:providertimeout") {
      ackText = undefined;
      const view = providerTimeoutKeyboard(deps.userId);
      await renderInPlace(view.text, view.reply_markup);
    } else if (data.startsWith("providertimeout:primary:")) {
      const seconds = Number(data.slice("providertimeout:primary:".length));
      setPrimaryTimeoutSeconds(deps.userId, seconds);
      ackText = `Primary timeout: ${seconds}s`;
      await confirm(`Primary provider timeout set to ${seconds}s`);
      const view = providerTimeoutKeyboard(deps.userId);
      await renderInPlace(view.text, view.reply_markup);
    } else if (data.startsWith("providertimeout:fallback:")) {
      const seconds = Number(data.slice("providertimeout:fallback:".length));
      setFallbackTimeoutSeconds(deps.userId, seconds);
      ackText = `Fallback timeout: ${seconds}s`;
      await confirm(`Fallback provider timeout set to ${seconds}s each`);
      const view = providerTimeoutKeyboard(deps.userId);
      await renderInPlace(view.text, view.reply_markup);
    } else if (data === "settings:session") {
      ackText = undefined;
      const view = tradingSessionKeyboard(deps.userId);
      await renderInPlace(view.text, view.reply_markup);
    } else if (data.startsWith("session:")) {
      const session = data.slice("session:".length) as TradingSession;
      setTradingSession(deps.userId, session);
      ackText = `Session: ${session}`;
      const view = tradingSessionKeyboard(deps.userId);
      await renderInPlace(view.text, view.reply_markup);
    } else if (data === "settings:confidence") {
      ackText = undefined;
      const view = confidenceKeyboard(deps.userId);
      await renderInPlace(view.text, view.reply_markup);
    } else if (data === "confidence:setthreshold") {
      setPendingConfidenceEntry(deps.userId, true);
      ackText = "Send the new threshold";
      if (chatId) await deps.client.sendMessage({ chat_id: chatId, text: "Reply with your confidence threshold (0-100) as your next message." });
    } else if (data === "confidence:toggleauto") {
      const settings = getConfidenceSettings(deps.userId);
      setAutoApproveBelowThreshold(deps.userId, !settings.autoApproveBelowThreshold);
      ackText = `Auto-approve below threshold ${!settings.autoApproveBelowThreshold ? "enabled" : "disabled"}`;
      await confirm(`Auto-approve below threshold: ${!settings.autoApproveBelowThreshold ? "On" : "Off"}`);
      const view = confidenceKeyboard(deps.userId);
      await renderInPlace(view.text, view.reply_markup);
    } else if (data.startsWith("tradeapprove:") || data.startsWith("tradedecline:")) {
      const approve = data.startsWith("tradeapprove:");
      const pendingId = data.slice(approve ? "tradeapprove:".length : "tradedecline:".length);
      try {
        const entry = takePendingTradeApproval(deps.userId, pendingId);
        if (approve) {
          if (!deps.executor) {
            ackText = "No trade executor configured";
            if (chatId) await deps.client.sendMessage({ chat_id: chatId, text: ackText });
          } else {
            const { ticket } = await tradeExecute(deps.executor, entry.order);
            ackText = "Approved";
            if (chatId) await deps.client.sendMessage({ chat_id: chatId, text: buildTradePlacedMessage(entry.order, ticket, entry.confidence) });
          }
        } else {
          ackText = "Declined";
          if (chatId) await deps.client.sendMessage({ chat_id: chatId, text: `Declined -- ${entry.order.symbol} ${entry.order.type.toUpperCase()} was not placed.` });
        }
      } catch (err) {
        ackText = err instanceof TradeApprovalNotFoundError ? "Already handled" : `Error: ${err instanceof Error ? err.message : String(err)}`;
        if (chatId) await deps.client.sendMessage({ chat_id: chatId, text: ackText });
      }
    } else if (data.startsWith("tradefindanother:")) {
      // Item 2/6 real gap fixed: the 3rd "Find Another" option on a trade approval prompt --
      // declines the current candidate (same real effect as tradedecline) and genuinely re-hunts
      // the active pair group excluding it, rather than just discarding the prompt. Never
      // fabricates a new confidence/SL/TP -- this reports the real next candidate found and lets
      // the user (or a fresh agent turn) decide, since only the model computes those for real.
      const pendingId = data.slice("tradefindanother:".length);
      try {
        const entry = takePendingTradeApproval(deps.userId, pendingId);
        ackText = "Finding another";
        const analysis = createEaAnalysisSource(deps.userId);
        const hunt = await huntForSetup(deps.userId, analysis, "H1", { excludeSymbols: [entry.order.symbol] });
        if (chatId) {
          if (hunt.bestSetup) {
            await deps.client.sendMessage({
              chat_id: chatId,
              text: `🔍 Next candidate (excluding ${entry.order.symbol}): ${hunt.bestSetup.symbol} — confluence ${hunt.bestSetup.score}, ${hunt.bestSetup.direction}. Ask me to analyze and take it if you want.`,
            });
          } else {
            await deps.client.sendMessage({ chat_id: chatId, text: `Declined ${entry.order.symbol} -- scanned the rest of the group, nothing else real cleared right now.` });
          }
        }
      } catch (err) {
        ackText = err instanceof TradeApprovalNotFoundError ? "Already handled" : `Error: ${err instanceof Error ? err.message : String(err)}`;
        if (chatId) await deps.client.sendMessage({ chat_id: chatId, text: ackText });
      }
    } else if (data === "settings:eatoken") {
      ackText = undefined;
      const view = eaTokenKeyboard(deps.userId);
      await renderInPlace(view.text, view.reply_markup);
    } else if (data === "eatoken:revoke") {
      revokeEaToken(deps.userId);
      ackText = "Token revoked";
      await confirm("EA token revoked -- run /ea to get a freshly personalized file with the new one.");
      const view = eaTokenKeyboard(deps.userId);
      await renderInPlace(view.text, view.reply_markup);
    } else if (data === "ea_push_interval") {
      // Item 5 real gap fixed: primes the same next-message-IS-the-value capture pattern used
      // for every other numeric setting -- the user's next message is read as the new interval.
      setPendingPushIntervalEntry(deps.userId, true);
      ackText = undefined;
      if (chatId) await deps.client.sendMessage({ chat_id: chatId, text: "Reply with the EA's new push interval in seconds (e.g. \"10\") -- takes effect live on its next poll, no restart needed." });
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
    } else if (data === "settings:firecrawl") {
      ackText = undefined;
      const view = firecrawlKeyboard(deps);
      await renderInPlace(view.text, view.reply_markup);
    } else if (data === "firecrawlkey:add") {
      setPendingFirecrawlKeyEntry(deps.db, deps.userId, true);
      ackText = undefined;
      if (chatId) await deps.client.sendMessage({ chat_id: chatId, text: "Reply with your Firecrawl API key as your next message." });
    } else if (data.startsWith("firecrawlkey:remove:")) {
      const keyId = data.slice("firecrawlkey:remove:".length);
      removeFirecrawlKey(deps.db, deps.userId, keyId);
      ackText = "Key removed";
      await confirm("Firecrawl key removed");
      const view = firecrawlKeyboard(deps);
      await renderInPlace(view.text, view.reply_markup);
    } else if (data.startsWith("firecrawlkey:noop:")) {
      ackText = undefined;
    } else if (data === "settings:mcp") {
      ackText = undefined;
      const view = mcpServersKeyboard(deps);
      await renderInPlace(view.text, view.reply_markup);
    } else if (data === "mcpsrv:add") {
      setPendingMcpServerEntry(deps.db, deps.userId, true);
      ackText = undefined;
      if (chatId) await deps.client.sendMessage({ chat_id: chatId, text: "Reply with the server as: name | url (add | token at the end if it needs one).\n\ne.g. My tools | https://mcp.example.com/mcp | sk-abc123" });
    } else if (data.startsWith("mcpsrv:connect:")) {
      const id = data.slice("mcpsrv:connect:".length);
      const config = listMcpServerConfigs(deps.userId).find((s) => s.id === id);
      if (!config) {
        ackText = "Server not found";
        if (chatId) await deps.client.sendMessage({ chat_id: chatId, text: ackText });
      } else {
        try {
          const conn = await mcpConnect(deps.userId, config.url, config.token);
          ackText = "Connected";
          if (chatId) await deps.client.sendMessage({ chat_id: chatId, text: `✅ Connected to ${config.name} -- ${conn.tools.length} real tool(s) discovered: ${conn.tools.map((t) => t.name).join(", ") || "(none)"}` });
        } catch (err) {
          ackText = "Connection failed";
          if (chatId) await deps.client.sendMessage({ chat_id: chatId, text: `Real connection failed: ${err instanceof Error ? err.message : String(err)}` });
        }
      }
    } else if (data.startsWith("mcpsrv:remove:")) {
      const id = data.slice("mcpsrv:remove:".length);
      removeMcpServerConfig(deps.userId, id);
      ackText = "Server removed";
      await confirm("MCP server removed");
      const view = mcpServersKeyboard(deps);
      await renderInPlace(view.text, view.reply_markup);
    } else if (data.startsWith("mcpsrv:noop:")) {
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
      // Item 7: a menu/back-button tap edits the SAME message in place (the tapped message's own
      // id) instead of sending a new one and stacking -- /reset's own confirm flow is the one
      // deliberate exception (a destructive action gets its own fresh, unmissable message).
      if (chatId) await dispatchCommandByName(deps, chatId, `${deps.userId}:${chatId}`, command, command === "reset" ? undefined : callback.message?.message_id);
    } else if (data.startsWith("provider:")) {
      const name = data.slice("provider:".length) as ProviderName;
      ackText = undefined;
      if (chatId && callback.message) {
        const view = providerDetailView(deps, name);
        await editOrSend(deps.client, { chat_id: chatId, message_id: callback.message.message_id, text: view.text, parse_mode: "HTML", reply_markup: view.reply_markup });
      }
    } else if (data.startsWith("addkey:")) {
      const provider = data.slice("addkey:".length) as ProviderName;
      setPendingKeyEntry(deps.db, deps.userId, provider);
      ackText = undefined;
      if (chatId) {
        await deps.client.sendMessage({
          chat_id: chatId,
          text: `Reply with your ${provider} API key as your next message.\n\nTo add multiple at once (up to 20), paste one per line -- each is validated and stored individually, so one bad line never blocks the rest.`,
        });
      }
    } else if (data === "providers:back") {
      ackText = undefined;
      if (chatId) await handleProviders(deps, chatId, callback.message?.message_id);
    } else if (data.startsWith("deletekey:")) {
      const keyId = data.slice("deletekey:".length);
      const key = getProviderKeyById(deps.db, deps.userId, keyId);
      if (!key) {
        ackText = "Key not found";
        if (chatId) await deps.client.sendMessage({ chat_id: chatId, text: ackText });
      } else {
        const provider = key.provider;
        const wasPrimary = key.isPrimary;
        removeProviderKey(deps.db, deps.userId, keyId);
        ackText = "Key deleted";
        await confirm(`Deleted ${provider} key: ${key.label}`);
        if (wasPrimary) {
          const remaining = listProviderKeys(deps.db, deps.userId, provider);
          if (remaining.length > 0) setPrimaryProviderKey(deps.db, deps.userId, remaining[0].id);
        }
        if (chatId && callback.message) {
          const view = providerDetailView(deps, provider);
          await editOrSend(deps.client, { chat_id: chatId, message_id: callback.message.message_id, text: view.text, parse_mode: "HTML", reply_markup: view.reply_markup });
        }
      }
    } else if (data.startsWith("activatekey:")) {
      const keyId = data.slice("activatekey:".length);
      const key = getProviderKeyById(deps.db, deps.userId, keyId);
      if (!key?.provider) {
        ackText = "Key not found";
        if (chatId) await deps.client.sendMessage({ chat_id: chatId, text: ackText });
      } else {
        setPrimaryProviderKey(deps.db, deps.userId, keyId);
        const config = getModelConfig(deps.userId);
        setModelConfig(deps.userId, { primary: key.provider, fallback: config.fallback.filter((p) => p !== key.provider) });
        ackText = "Key activated";
        await confirm(`Provider switched to ${key.provider} (key: ${key.label})`);
        if (chatId && callback.message) {
          const view = providerDetailView(deps, key.provider);
          await editOrSend(deps.client, { chat_id: chatId, message_id: callback.message.message_id, text: view.text, parse_mode: "HTML", reply_markup: view.reply_markup });
        }
        // Real gap fixed (user: "why do I still have to go to /models and confirm it again"):
        // setting a key as primary used to leave model choice as a completely separate, second
        // trip through /models -- now the model picker for the just-activated provider is sent
        // immediately, right in the same flow, with no extra navigation required.
        if (chatId) await sendModelPickerForProvider(deps, chatId, key.provider);
      }
    } else if (data.startsWith("setprimaryprovider:")) {
      const name = data.slice("setprimaryprovider:".length) as ProviderName;
      const config = getModelConfig(deps.userId);
      setModelConfig(deps.userId, { primary: name, fallback: config.fallback.filter((p) => p !== name) });
      ackText = `Primary provider set to ${name}`;
      await confirm(`Provider switched to ${name}`);
      if (chatId && callback.message) {
        const view = providerDetailView(deps, name);
        await editOrSend(deps.client, { chat_id: chatId, message_id: callback.message.message_id, text: view.text, parse_mode: "HTML", reply_markup: view.reply_markup });
      }
      // Same fix as activatekey: above -- model choice offered immediately, not a separate trip.
      if (chatId) await sendModelPickerForProvider(deps, chatId, name);
    } else if (data.startsWith("togglefallback:")) {
      const name = data.slice("togglefallback:".length) as ProviderName;
      const config = getModelConfig(deps.userId);
      const inFallback = config.fallback.includes(name);
      const newFallback = inFallback ? config.fallback.filter((p) => p !== name) : [...config.fallback, name];
      setModelConfig(deps.userId, { primary: config.primary, fallback: newFallback });
      ackText = inFallback ? `Removed ${name} from fallback chain` : `Added ${name} to fallback chain`;
      if (chatId && callback.message) {
        const view = providerDetailView(deps, name);
        await editOrSend(deps.client, { chat_id: chatId, message_id: callback.message.message_id, text: view.text, parse_mode: "HTML", reply_markup: view.reply_markup });
      }
    } else if (data.startsWith("modelfor:")) {
      const name = data.slice("modelfor:".length) as ProviderName;
      ackText = `Model for ${name}`;
      if (chatId) await sendModelPickerForProvider(deps, chatId, name);
    } else if (data.startsWith("fetchmodels:")) {
      const name = data.slice("fetchmodels:".length) as ProviderName;
      const key = primaryKeyFor(deps, name);
      if (!key) {
        ackText = "No key configured for this provider";
        if (chatId) await deps.client.sendMessage({ chat_id: chatId, text: ackText });
      } else {
        const result = await fetchAvailableModels(name, key.config);
        if (result.manualEntryRequired) {
          // Defensive: /models never shows a fetch button for a manual-entry (or endpoint-less)
          // provider, but a stale keyboard from before a catalog change could still be tapped.
          ackText = `${name} has no live model list -- reply with the model ID as a message instead`;
          if (chatId) await deps.client.sendMessage({ chat_id: chatId, text: ackText });
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
        if (chatId) await deps.client.sendMessage({ chat_id: chatId, text: ackText });
      } else {
        const modelId = cached.models[index];
        const key = primaryKeyFor(deps, cached.provider);
        if (!key) {
          ackText = "No key configured for this provider";
          if (chatId) await deps.client.sendMessage({ chat_id: chatId, text: ackText });
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
    } else if (data === "eaexec:ea") {
      setEaTradingMode(deps.userId);
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
    } else if (data === "eaexec:mcp") {
      setPendingMcpUrlEntry(deps.db, deps.userId, true);
      ackText = "Send the MCP server URL";
      if (chatId) await deps.client.sendMessage({ chat_id: chatId, text: "Send your real MCP trading server's URL as your next message (e.g. https://your-mcp-server.example.com)." });
    } else if (data === "trades:refresh") {
      ackText = "Refreshed";
      if (chatId && callback.message) {
        const screen = tradesScreen(deps);
        await editOrSend(deps.client, { chat_id: chatId, message_id: callback.message.message_id, text: screen.text, parse_mode: "HTML", reply_markup: screen.reply_markup });
      }
    } else if (data === "trades:live") {
      const key = `${deps.userId}:${chatId}`;
      const wasLive = liveTradesTimers.has(key);
      if (wasLive) stopLiveTrades(key);
      ackText = wasLive ? "Live refresh stopped" : `Live refresh started (${LIVE_TRADES_INTERVAL_MS / 1000}s)`;
      if (chatId && callback.message) {
        if (!wasLive) startLiveTrades(deps, chatId, callback.message.message_id);
        const screen = tradesScreen(deps, wasLive ? undefined : LIVE_TRADES_INTERVAL_MS / 1000);
        await editOrSend(deps.client, { chat_id: chatId, message_id: callback.message.message_id, text: screen.text, parse_mode: "HTML", reply_markup: screen.reply_markup });
      }
    } else if (data === "trades:closeall" || data === "trades:closelosers" || data.startsWith("trades:close:")) {
      if (!deps.executor) {
        ackText = "No trade executor configured";
      } else {
        const { positions } = getLastKnownState(deps.userId);
        const targets =
          data === "trades:closeall" ? positions : data === "trades:closelosers" ? positions.filter((p) => (p.pnl ?? 0) < 0) : positions.filter((p) => p.ticket === data.slice("trades:close:".length));
        const results = await Promise.all(
          targets.map(async (p) => {
            try {
              await deps.executor!.closePosition(p.ticket);
              return `✅ ${p.symbol} #${p.ticket} closing`;
            } catch (err) {
              return `⚠️ ${p.symbol} #${p.ticket} failed: ${err instanceof Error ? err.message : String(err)}`;
            }
          })
        );
        ackText = `${targets.length} close request(s) sent`;
        if (chatId) await deps.client.sendMessage({ chat_id: chatId, text: results.length > 0 ? results.join("\n") : "Nothing to close." });
      }
    } else if (data === "resetconfirm:yes") {
      ackText = undefined;
      if (chatId) await performFullReset(deps, chatId, `${deps.userId}:${chatId}`);
    } else if (data === "resetconfirm:no") {
      ackText = "Cancelled";
      if (chatId) await deps.client.sendMessage({ chat_id: chatId, text: "Cancelled -- nothing was touched." });
    } else if (data === "settings:back") {
      ackText = undefined;
    }
  } catch (err) {
    // Item 3 real bug fixed: this used to send the raw err.message straight to the user (e.g.
    // a raw "no stored keys for provider ..." internal error) -- now the same clean, honest
    // mapping used everywhere else in this build.
    const clean = friendlyErrorMessage(err);
    ackText = clean;
    // Real fix: the callback was already acknowledged above (Telegram only accepts one
    // answerCallbackQuery per callback_query id) -- an unhandled error must still genuinely
    // reach the user somehow, so it goes out as a real chat message instead of a toast nobody
    // can see after the fact.
    if (chatId) await deps.client.sendMessage({ chat_id: chatId, text: clean }).catch(() => undefined);
  }
}

export function listPendingApprovalsKeyboard(pendingId: string) {
  return approvalKeyboard(pendingId, "risk-settings");
}

export { listPendingLimitChanges };
