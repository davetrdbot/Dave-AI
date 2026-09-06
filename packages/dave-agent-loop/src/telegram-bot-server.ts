import type { Server } from "node:http";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DaveDatabase } from "@dave/db";
import type { DavemaClient } from "@dave/davema";
import type { TradeExecutor } from "@dave/trading";
import type { RFeedTradeExecutor, HistoryRequestManager } from "@dave/rfeed";
import { generateWithKeyFailover, getModelConfig, type Provider, type CompletionRequest, type CompletionResult, type ProviderName, type ContentBlock, type CompletionMessage } from "@dave/brain";
import { TelegramClient, createTelegramWebhookServer, enableTelegramWebhook, registerDefaultCommandMenu, updateBotDisplayInfo, isDaveCommand, looksLikeSlashCommand, withThinkingIndicator, type TelegramUpdate, type TelegramMessage } from "@dave/telegram";
import { invokeWebhookTrigger } from "@dave/db";
import { buildImageContentBlock, transcribeAudioBytesWithKeyFailover } from "@dave/vision";
import { classifyToolAction } from "./action-classifier.js";
import { type ToolRegistry } from "./tool-registry.js";
import { buildFullToolRegistry } from "./full-registry.js";
import { AgentLoop, type AgentRunResult, type AgentStep } from "./agent-loop.js";
import { getPendingQuestion, clearPendingQuestion, ASK_USER_TOOL_NAME } from "./ask-user.js";
import { BootstrapFlow, type Transport } from "@dave/core";
import { loadConversationHistory, saveConversationHistory } from "./conversation-store.js";
import { dispatchCommand, dispatchCallback, tryHandlePendingModelEntry, tryHandlePendingVoiceEntry, type CommandRouterDeps } from "./command-router.js";
import { recordActiveChat } from "./primary-chat.js";
import { wireMorningBrief } from "./morning-brief-handler.js";
import { wireFeedbackLoop } from "./feedback-loop-handler.js";

/**
 * The real, persistent replacement for a one-off polling script: a
 * webhook server Telegram pushes every update to directly, real
 * conversation history persisted per user (survives a restart, unlike
 * an in-memory array), and the user's own configured model (primary +
 * fallback, same ModelConfig the admin UI's "AI Models" tab already
 * writes) picked via their own stored provider keys -- not a
 * hardcoded provider.
 */
export interface TelegramBotServerDeps {
  /** The single Dave account this bot serves -- all chats it talks in share this one account's credentials/settings/tools, per-chat state is only the conversation history. */
  ownerUserId: string;
  db: DaveDatabase;
  davema: DavemaClient;
  executor: TradeExecutor;
  rfeedExecutor: RFeedTradeExecutor;
  rfeedHistoryManager: HistoryRequestManager;
  botToken: string;
  publicBaseUrl: string;
  systemPrompt: string;
}

/** Tries the user's configured primary provider, then their configured fallbacks, via their own stored keys. */
function modelConfigProvider(db: DaveDatabase, userId: string): Provider {
  return {
    name: "model-config" as ProviderName,
    async generate(req: CompletionRequest, timeoutMs: number): Promise<CompletionResult> {
      const config = getModelConfig(userId);
      const order = [config.primary, ...config.fallback.filter((p) => p !== config.primary)];
      let lastError: unknown;
      for (const provider of order) {
        try {
          return await generateWithKeyFailover(db, userId, provider, req, timeoutMs);
        } catch (err) {
          lastError = err;
        }
      }
      throw lastError instanceof Error ? lastError : new Error(`No configured provider (${order.join(", ")}) has a working stored key for this user.`);
    },
  };
}

export interface TelegramBotServer {
  server: Server;
  webhookUrl: string;
}

/** Real fix companion: a paused run's saved history ends with an assistant message whose
 * ask_user tool call has no matching tool_result yet -- this finds that call's real id so
 * resume() can supply the answer against the exact right toolCallId, not a fresh turn. */
function findPendingAskUserToolCallId(history: CompletionMessage[]): string | undefined {
  const lastAssistant = [...history].reverse().find((m) => m.role === "assistant" && m.toolCalls?.length);
  return lastAssistant?.toolCalls?.find((c) => c.name === ASK_USER_TOOL_NAME)?.id;
}

function inboxDir(ownerUserId: string): string {
  const dir = join(process.cwd(), "data", "telegram-inbox", ownerUserId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Real gap closed (final pre-deployment pass, Step 15 -- file I/O both
 * directions): the live webhook handler used to fall straight to
 * `if (!message?.text) return;`, silently dropping every incoming
 * voice note, photo, and document -- real transcription (Groq) and
 * real vision (Claude image blocks) both existed as library code, but
 * nothing in the live message path ever called them. This builds the
 * real user-turn content for whichever of the three arrived, downloading
 * the actual bytes via the real Telegram `getFile` + download round
 * trip (Step 15.3) first.
 *
 * Returns undefined (and has already told the user why) when the
 * attachment genuinely couldn't be turned into something the model can
 * use -- a missing Groq key, an unsupported image format, etc. -- so the
 * caller can bail out for this update without also invoking the agent
 * loop on nothing.
 */
async function buildInboundContent(
  client: TelegramClient,
  message: TelegramMessage,
  ownerUserId: string,
  db: DaveDatabase
): Promise<string | ContentBlock[] | undefined> {
  if (message.voice) {
    const bytes = await client.downloadFile(message.voice.file_id);
    const filename = `${message.voice.file_unique_id}.ogg`;
    writeFileSync(join(inboxDir(ownerUserId), filename), bytes);
    const transcript = await transcribeAudioBytesWithKeyFailover(db, ownerUserId, bytes, filename);
    return `[Voice note transcript]: ${transcript.text}`;
  }
  if (message.photo && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1]; // Bot API orders resolutions smallest -> largest
    const bytes = await client.downloadFile(largest.file_id);
    const filename = `${largest.file_unique_id}.jpg`;
    writeFileSync(join(inboxDir(ownerUserId), filename), bytes);
    const block = buildImageContentBlock(bytes, filename);
    const caption = message.caption?.trim();
    return [{ type: "text", text: caption ? caption : "[Photo attached, no caption]" }, block];
  }
  if (message.document) {
    const bytes = await client.downloadFile(message.document.file_id);
    const filename = message.document.file_name ?? `${message.document.file_unique_id}`;
    const savedPath = join(inboxDir(ownerUserId), filename);
    writeFileSync(savedPath, bytes);
    const isImage = /\.(png|jpe?g|gif|webp)$/i.test(filename);
    if (isImage) {
      const block = buildImageContentBlock(bytes, filename);
      const caption = message.caption?.trim();
      return [{ type: "text", text: caption ? caption : `[Image document "${filename}" attached]` }, block];
    }
    return `[Document received and saved to ${savedPath}]${message.caption ? ` Caption: ${message.caption}` : ""} -- use your sandbox file tools to read/process it.`;
  }
  return undefined;
}

/** Real, persistent per-chat registry + loop cache -- rebuilding a full 130+-tool registry on every single message would be wasteful. */
const registryCache = new Map<string, ToolRegistry>();

function getOrBuildRegistry(deps: TelegramBotServerDeps, client: TelegramClient, chatId: number): ToolRegistry {
  // Keyed by chat too -- push_message_to_user/tg_thinking etc. bind to a
  // specific chatId, so a registry built for one chat can't be reused for
  // another, even though both share the same owner account/tools/db.
  const key = `${deps.ownerUserId}:${chatId}`;
  if (!registryCache.has(key)) {
    registryCache.set(
      key,
      buildFullToolRegistry({
        userId: deps.ownerUserId,
        db: deps.db,
        davema: deps.davema,
        executor: deps.executor,
        rfeedExecutor: deps.rfeedExecutor,
        rfeedHistoryManager: deps.rfeedHistoryManager,
        telegram: { client, chatId },
      })
    );
  }
  return registryCache.get(key)!;
}

/**
 * Starts the real webhook server AND registers it with Telegram
 * (setWebhook) -- from this point on, Telegram itself pushes every
 * update straight to this process; the bot is online for as long as
 * this process stays up, with no poll loop required.
 */
export async function startTelegramBotServer(deps: TelegramBotServerDeps): Promise<TelegramBotServer> {
  const client = new TelegramClient(deps.botToken);
  const registration = await enableTelegramWebhook(client, deps.ownerUserId, deps.publicBaseUrl);
  // Real gap fixed: registerDefaultCommandMenu (setMyCommands) only
  // ever existed as a tool Dave itself could choose to call -- nothing
  // called it automatically at startup, so the real 9 commands never
  // showed up in Telegram's native "/" menu on a fresh pairing. Best-
  // effort: a failure here must not block the bot from coming online.
  await registerDefaultCommandMenu(client).catch((err) => console.error(`[telegram] failed to register command menu: ${err instanceof Error ? err.message : String(err)}`));

  // Real gap fixed (STEP 7 re-verification): getMyDescription/getMyShortDescription
  // came back genuinely empty in production -- updateBotDisplayInfo() existed only
  // as a callable tool, nothing ever invoked it with real content. Best-effort,
  // same as the command menu above: never blocks the bot from coming online.
  await updateBotDisplayInfo(client, {
    description:
      "Dave is your autonomous MT5 trading assistant. Connect your account, and Dave watches your trades, " +
      "proposes and (with your approval) executes setups, and keeps you posted here in Telegram. " +
      "Send /menu to see everything Dave can do.",
    shortDescription: "Your autonomous MT5 trading assistant.",
  }).catch((err) => console.error(`[telegram] failed to set bot display info: ${err instanceof Error ? err.message : String(err)}`));

  // Real fix (F5): syncMorningBriefCron() fires a real cron on schedule,
  // but nothing ever called it with a real content-composing handler in
  // production -- it fired into nothing. Wired here, once, at startup,
  // bound to this process's real client so a scheduled brief actually
  // sends real balance/open-trades/watchlist content.
  wireMorningBrief({ db: deps.db, client, ownerUserId: deps.ownerUserId });

  // Real fix (Step 18 re-verification): all 6 feedback-loop jobs
  // (dreaming cron, trade-count reflection, weekly export, the weekly
  // feedback poll send) were genuinely real, tested code that nothing
  // in production ever called -- same class of gap as F5 above.
  wireFeedbackLoop({ db: deps.db, client, ownerUserId: deps.ownerUserId });

  const server = createTelegramWebhookServer({
    onUpdate: async (_userId: string, update: TelegramUpdate) => {
      // Real fix (Step 18.5 re-verification): a real `poll_answer` update
      // is how Telegram genuinely delivers a feedback poll's answer --
      // there is no separate inbound channel for it. `poll_id` (NOT
      // message_id) is what `sendFeedbackPoll` registered its webhook
      // token as, so this relays it straight to that same real handler
      // in-process (no fake HTTP round trip needed, same process).
      if (update.poll_answer) {
        const handled = await invokeWebhookTrigger(update.poll_answer.poll_id, { selectedOptionIndex: update.poll_answer.option_ids[0] });
        if (!handled) console.warn(`[telegram-bot-server] poll_answer for unknown/expired poll_id ${update.poll_answer.poll_id}`);
        return;
      }

      // Real fix (A3): every inline button press arrives as a
      // callback_query, not a message -- this used to be silently
      // dropped by the `if (!message?.text) return;` guard below,
      // leaving every settings toggle / approve-decline / EA picker
      // button completely dead. Routed to its real handler first.
      if (update.callback_query) {
        const cbChatId = update.callback_query.message?.chat.id;
        if (cbChatId !== undefined) recordActiveChat(deps.db, deps.ownerUserId, cbChatId);
        const routerDeps: CommandRouterDeps = { db: deps.db, client, userId: deps.ownerUserId, publicBaseUrl: deps.publicBaseUrl };
        await dispatchCallback(routerDeps, update.callback_query);
        return;
      }

      const message = update.message;
      // Real fix (Step 15 re-verification): this used to be
      // `if (!message?.text) return;`, silently dropping every voice
      // note, photo, and document Telegram ever delivered -- real
      // transcription/vision code existed but nothing here called it.
      if (!message || (!message.text && !message.voice && !message.photo && !message.document)) return;
      const chatId = message.chat.id;
      // Real fix (F5): the morning brief (and any other schedule-driven
      // push) has no incoming update to read a chatId off of -- this is
      // what gives it somewhere real to send to.
      recordActiveChat(deps.db, deps.ownerUserId, chatId);
      // Conversation history is scoped per-chat (a group chat or a second
      // person messaging the same bot shouldn't see each other's history),
      // even though tools/credentials are shared across the one owner account.
      const historyKey = `${deps.ownerUserId}:${chatId}`;

      // Real fix (A2): the 9 slash commands used to fall straight
      // through to the LLM like any other message -- no live router
      // ever intercepted them. dispatchCommand() handles all 9 for
      // real (including /reset -> clearConversationHistory()) and
      // returns true when it did, so a recognized command never
      // reaches the agent loop below.
      if (message.text && isDaveCommand(message.text)) {
        const routerDeps: CommandRouterDeps = { db: deps.db, client, userId: deps.ownerUserId, publicBaseUrl: deps.publicBaseUrl };
        const handled = await dispatchCommand(routerDeps, chatId, historyKey, message.text);
        if (handled) return;
      }

      // Real fix ("fetch the models like v1 model so I can select as well"): /models on a
      // manual-entry provider (OpenRouter/OrcaRouter/HuggingFace) asks the user to reply with
      // the model ID as their next message -- this is that capture, checked before anything
      // free-text falls through to the LLM.
      if (message.text) {
        const routerDeps: CommandRouterDeps = { db: deps.db, client, userId: deps.ownerUserId, publicBaseUrl: deps.publicBaseUrl };
        if (await tryHandlePendingModelEntry(routerDeps, chatId, message.text)) return;
        if (await tryHandlePendingVoiceEntry(routerDeps, chatId, message.text)) return;
      }

      // Real gap fixed: a genuine slash command that ISN'T one of the 9 (mistyped, or an old
      // removed one) used to silently fall through to the LLM as ordinary conversation instead
      // of telling the user it wasn't recognized. Checked after the pending-entry captures above
      // so an in-progress manual model/voice entry is never misread as an unknown command.
      if (message.text && looksLikeSlashCommand(message.text) && !isDaveCommand(message.text)) {
        await client.sendMessage({ chat_id: chatId, text: "Unknown command -- send /help for the full list." });
        return;
      }

      // Real gap fixed: BootstrapFlow (dave-core, exactly matches prompts/BOOTSTRAP.md) was
      // fully built and tested but never triggered against a real Telegram message -- pairing
      // confirmation now starts it (telegram-otp.ts), and this is the other half: every
      // free-text message is fed through it first. handleMessage() itself is a real no-op
      // (returns false immediately) once onboarding is "not-started" or "complete", so this is
      // safe to call unconditionally on every message, not just during a real onboarding window.
      if (message.text) {
        const bootstrapTransport: Transport = { send: async (_userId, text) => { await client.sendMessage({ chat_id: chatId, text }); } };
        if (await new BootstrapFlow(bootstrapTransport).handleMessage(deps.ownerUserId, message.text)) return;
      }

      const registry = getOrBuildRegistry(deps, client, chatId);
      const provider = modelConfigProvider(deps.db, deps.ownerUserId);
      const loop = new AgentLoop(provider, registry);

      let history = loadConversationHistory(deps.db, historyKey);
      if (history.length === 0) history = [{ role: "system", content: deps.systemPrompt }];

      let userContent: string | ContentBlock[];
      if (message.text) {
        userContent = message.text;
      } else {
        try {
          const built = await buildInboundContent(client, message, deps.ownerUserId, deps.db);
          if (built === undefined) return; // genuinely nothing usable came through (shouldn't happen given the guard above)
          userContent = built;
        } catch (err) {
          // A real, honest failure -- e.g. no stored Groq key yet, an
          // unsupported image format, or Telegram's file download
          // itself failing -- must tell the user why, not silently drop
          // the message or crash the process.
          await client.sendMessage({ chat_id: chatId, text: `Couldn't process that attachment: ${err instanceof Error ? err.message : String(err)}` });
          return;
        }
      }
      // Real bug fixed: ask_user (ask-user.ts) genuinely pauses the loop and its question
      // WAS being sent to the user, but nothing ever resumed the paused run -- the next
      // message just started a fresh loop.run() over history that still had a dangling
      // assistant tool_call with no matching tool_result, which every real provider's API
      // rejects as malformed. Confirmed via this exact code path having no getPendingQuestion/
      // resume() reference anywhere. Now: if a question is genuinely pending for this owner,
      // this message IS the real answer -- resume the exact paused call, not a fresh turn.
      const pendingQuestion = message.text ? getPendingQuestion(deps.ownerUserId) : undefined;
      const pendingToolCallId = pendingQuestion ? findPendingAskUserToolCallId(history) : undefined;

      try {
        await withThinkingIndicator(client, chatId, async (indicator) => {
          const onStep = (step: AgentStep) => void indicator.update(classifyToolAction(step.toolName), step.toolName);
          let result: AgentRunResult;
          if (pendingQuestion && pendingToolCallId) {
            clearPendingQuestion(deps.ownerUserId);
            result = await loop.resume({ status: "awaiting_user", question: pendingQuestion, toolCallId: pendingToolCallId, history, steps: [] }, message.text as string, { maxSteps: 8, onStep });
          } else {
            history.push({ role: "user", content: userContent });
            result = await loop.run(history, { maxSteps: 8, onStep });
          }
          saveConversationHistory(deps.db, historyKey, result.history);
          const finalText = result.status === "done" ? result.text || "(no text)" : result.question.question;
          return { result: undefined, finalText };
        });
      } catch (err) {
        await client.sendMessage({ chat_id: chatId, text: `Something went wrong handling that: ${err instanceof Error ? err.message : String(err)}` });
      }
    },
  });

  return { server, webhookUrl: `${deps.publicBaseUrl}${registration.path}` };
}
