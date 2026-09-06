import type { DaveDatabase } from "@dave/db";
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
import { getLastKnownAccountSnapshot, getLastKnownState } from "@dave/ea-bridge";
import {
  getRiskSettings,
  setRiskMode,
  getAutoApprovalEnabled,
  setAutoApprovalEnabled,
  listPendingLimitChanges,
  approveSettingsChange,
  declineSettingsChange,
  type RiskMode,
} from "@dave/trading";
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
  const text =
    `<b>Account</b>\n` +
    `Account: ${snapshot.account}\n` +
    `Balance: ${formatMoney(snapshot.balance)}\n` +
    `Equity: ${formatMoney(snapshot.equity)}\n` +
    `Margin: ${formatMoney(snapshot.margin)}\n` +
    `Free margin: ${formatMoney(snapshot.freeMargin)}`;
  await deps.client.sendMessage({ chat_id: chatId, text, parse_mode: "HTML" });
}

async function handleConnection(deps: CommandRouterDeps, chatId: number): Promise<void> {
  const state = getLastKnownState(deps.userId);
  const text =
    `<b>Connection</b>\n` +
    `Open positions: ${state.positions.length}\n` +
    `Pending orders: ${state.pendingOrders.length}`;
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

async function handleProviders(deps: CommandRouterDeps, chatId: number): Promise<void> {
  const config = getModelConfig(deps.userId);
  const configuredProviders = new Set(listProviderKeys(deps.db, deps.userId).map((k) => k.provider));
  const catalogCount = listProviderCatalog().filter((e) => e.id !== "custom").length;
  const text =
    `<b>AI Provider</b>\nPrimary: ${config.primary}\nFallback: ${config.fallback.join(", ") || "none"}\n\n` +
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
    lines.push("No keys stored yet -- add one in the admin panel's Provider Keys tab.");
  } else {
    lines.push(`${keys.length} stored key(s):`);
  }
  const rows: ReturnType<typeof coloredButton>[][] = [];
  for (const key of keys) {
    const health = key.healthy ? "🟢" : "🔴";
    const star = key.isPrimary ? "⭐ " : "";
    rows.push([coloredButton(`${star}${health} ${key.label}`, key.isPrimary ? "green" : "neutral", `activatekey:${key.id}`)]);
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

async function handleModels(deps: CommandRouterDeps, chatId: number): Promise<void> {
  const config = getModelConfig(deps.userId);
  const provider = config.primary;
  const entry = listProviderCatalog().find((e) => e.id === provider)!;
  const key = primaryKeyFor(deps, provider);
  if (provider !== "airllm" && !key) {
    await deps.client.sendMessage({ chat_id: chatId, text: `No key configured for <b>${provider}</b> yet -- add one in the admin panel, or /providers to switch.`, parse_mode: "HTML" });
    return;
  }
  const activeModel = key?.config.model ?? entry.defaultModel;
  if (entry.manualModelEntry) {
    setPendingManualModelEntry(deps.db, deps.userId, provider);
    await deps.client.sendMessage({
      chat_id: chatId,
      text: `<b>Model for ${provider}</b>\nCurrent: <code>${activeModel}</code>\n\n${provider} requires manual model entry -- reply with the exact model ID as your next message and I'll set it.`,
      parse_mode: "HTML",
    });
    return;
  }
  await deps.client.sendMessage({
    chat_id: chatId,
    text: `<b>Model for ${provider}</b>\nCurrent: <code>${activeModel}</code>\n\nTap below to fetch the live model list from ${provider}'s real API and pick one.`,
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

function modeLabel(mode: RiskMode, value?: number): string {
  if (mode === "on") return `On (${value})`;
  return mode === "auto" ? "Auto" : "Off";
}

function settingsKeyboard(userId: string) {
  const settings = getRiskSettings(userId);
  const autoApproval = getAutoApprovalEnabled(userId);
  return settingsScreen(
    [
      [
        { label: `SL: ${modeLabel(settings.slMode, settings.slValue)}`, callbackData: "cyclemode:sl", active: false },
        { label: `TP: ${modeLabel(settings.tpMode, settings.tpValue)}`, callbackData: "cyclemode:tp", active: false },
      ],
      [{ label: `Lot: ${modeLabel(settings.lotMode, settings.lotValue)}`, callbackData: "cyclemode:lot", active: false }],
      [{ label: `Auto-approve Dave's proposals: ${autoApproval ? "On" : "Off"}`, callbackData: "toggleautoapproval", active: autoApproval }],
    ],
    "settings:back"
  );
}

async function handleSettings(deps: CommandRouterDeps, chatId: number): Promise<void> {
  await deps.client.sendMessage({ chat_id: chatId, text: "<b>Settings</b>", parse_mode: "HTML", reply_markup: settingsKeyboard(deps.userId) });
}

async function handleReset(deps: CommandRouterDeps, chatId: number, historyKey: string): Promise<void> {
  clearConversationHistory(deps.db, historyKey);
  await deps.client.sendMessage({ chat_id: chatId, text: "Conversation history cleared -- starting fresh." });
}

async function handleHelp(deps: CommandRouterDeps, chatId: number): Promise<void> {
  const lines = DAVE_COMMANDS.map((c) => `/${c.command} -- ${c.description}`);
  await deps.client.sendMessage({ chat_id: chatId, text: `<b>What I can do</b>\n${lines.join("\n")}`, parse_mode: "HTML" });
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
export async function dispatchCommand(deps: CommandRouterDeps, chatId: number, historyKey: string, text: string): Promise<boolean> {
  const parsed = parseCommand(text);
  if (!parsed) return false;
  const command: DaveCommand = parsed.command;
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
    case "menu":
      await handleHelp(deps, chatId);
      break;
    case "status":
      await handleStatus(deps, chatId);
      break;
    case "ea":
      await handleEa(deps, chatId);
      break;
  }
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

  try {
    if (data.startsWith("cyclemode:")) {
      const field = data.slice("cyclemode:".length) as RiskField;
      if (RISK_FIELDS.includes(field)) {
        const settings = getRiskSettings(deps.userId);
        const current = field === "sl" ? settings.slMode : field === "tp" ? settings.tpMode : settings.lotMode;
        setRiskMode(deps.userId, field, nextMode(current));
        ackText = `${field.toUpperCase()} updated`;
        if (chatId && callback.message) {
          await deps.client.editMessageText({ chat_id: chatId, message_id: callback.message.message_id, text: "<b>Settings</b>", parse_mode: "HTML", reply_markup: settingsKeyboard(deps.userId) }).catch(() =>
            deps.client.sendMessage({ chat_id: chatId, text: "<b>Settings</b>", parse_mode: "HTML", reply_markup: settingsKeyboard(deps.userId) })
          );
        }
      }
    } else if (data === "toggleautoapproval") {
      const enabled = getAutoApprovalEnabled(deps.userId);
      setAutoApprovalEnabled(deps.userId, !enabled);
      ackText = `Auto-approval ${!enabled ? "enabled" : "disabled"}`;
      if (chatId && callback.message) {
        await deps.client.editMessageText({ chat_id: chatId, message_id: callback.message.message_id, text: "<b>Settings</b>", parse_mode: "HTML", reply_markup: settingsKeyboard(deps.userId) }).catch(() =>
          deps.client.sendMessage({ chat_id: chatId, text: "<b>Settings</b>", parse_mode: "HTML", reply_markup: settingsKeyboard(deps.userId) })
        );
      }
    } else if (data.startsWith("provider:")) {
      const name = data.slice("provider:".length) as ProviderName;
      ackText = undefined;
      if (chatId && callback.message) {
        const view = providerDetailView(deps, name);
        await deps.client.editMessageText({ chat_id: chatId, message_id: callback.message.message_id, text: view.text, parse_mode: "HTML", reply_markup: view.reply_markup }).catch(() =>
          deps.client.sendMessage({ chat_id: chatId, text: view.text, parse_mode: "HTML", reply_markup: view.reply_markup })
        );
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
        if (result.error) {
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
        if (chatId) await deps.client.sendMessage({ chat_id: chatId, text: `Approved. SL=${modeLabel(settings.slMode, settings.slValue)} TP=${modeLabel(settings.tpMode, settings.tpValue)} Lot=${modeLabel(settings.lotMode, settings.lotValue)}` });
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
