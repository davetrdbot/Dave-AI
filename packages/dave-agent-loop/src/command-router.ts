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
import { getModelConfig, setModelConfig, type ProviderName } from "@dave/brain";
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

const PROVIDERS: ProviderName[] = ["airllm", "deepseek", "claude"];
/** Read-only, honest listing -- these providers' models are hardcoded in dave-brain's provider classes, not user-editable per-provider yet. */
const PROVIDER_MODELS: Record<string, string> = {
  airllm: "Qwen3-235B (self-hosted via AirLLM, AIRLLM_BASE_URL)",
  deepseek: "deepseek-chat",
  claude: "claude-sonnet-5",
};

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

function providersKeyboard(current: ProviderName) {
  return keyboard(
    PROVIDERS.map((p) => [coloredButton(current === p ? `✅ ${p}` : p, current === p ? "green" : "neutral", `provider:${p}`)])
  );
}

async function handleProviders(deps: CommandRouterDeps, chatId: number): Promise<void> {
  const config = getModelConfig(deps.userId);
  const text = `<b>AI Provider</b>\nPrimary: ${config.primary}\nFallback: ${config.fallback.join(", ") || "none"}\n\nTap to set primary:`;
  await deps.client.sendMessage({ chat_id: chatId, text, parse_mode: "HTML", reply_markup: providersKeyboard(config.primary) });
}

async function handleModels(deps: CommandRouterDeps, chatId: number): Promise<void> {
  const lines = PROVIDERS.map((p) => `${p}: ${PROVIDER_MODELS[p]}`);
  await deps.client.sendMessage({
    chat_id: chatId,
    text: `<b>Models per provider</b>\n${lines.join("\n")}\n\n(Each provider's model is fixed in its configuration -- not yet a per-model picker; this is an honest read-only view.)`,
    parse_mode: "HTML",
  });
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
      const config = getModelConfig(deps.userId);
      setModelConfig(deps.userId, { primary: name, fallback: config.fallback.filter((p) => p !== name) });
      ackText = `Primary provider set to ${name}`;
      if (chatId) await deps.client.sendMessage({ chat_id: chatId, text: `Primary provider set to <b>${name}</b>.`, parse_mode: "HTML" });
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
