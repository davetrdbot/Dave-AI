import type { Server } from "node:http";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DaveDatabase } from "@dave/db";
import type { DavemaClient } from "@dave/davema";
import type { TradeExecutor } from "@dave/trading";
import { generateWithKeyFailover, getModelConfig, type Provider, type CompletionRequest, type CompletionResult, type ProviderName, type ContentBlock, type CompletionMessage } from "@dave/brain";
import { TelegramClient, createTelegramWebhookServer, enableTelegramWebhook, registerDefaultCommandMenu, updateBotDisplayInfo, isDaveCommand, looksLikeSlashCommand, withThinkingIndicator, markdownToTelegramHtml, type TelegramUpdate, type TelegramMessage } from "@dave/telegram";
import { invokeWebhookTrigger } from "@dave/db";
import { buildImageContentBlock, transcribeAudioBytesWithKeyFailover } from "@dave/vision";
import { classifyToolAction } from "./action-classifier.js";
import { type ToolRegistry } from "./tool-registry.js";
import { buildFullToolRegistry } from "./full-registry.js";
import { AgentLoop, type AgentRunResult, type AgentStep } from "./agent-loop.js";
import { getPendingQuestion, clearPendingQuestion, ASK_USER_TOOL_NAME } from "./ask-user.js";
import { BootstrapFlow, type Transport } from "@dave/core";
import { stopOrPanic, isTradingHalted } from "@dave/safety";
import { startAutonomousTradingLoop, stopAutonomousTradingLoop, isAutonomousTradingRunning, setAutonomousTradingIntervalMinutes, getTradingLoopIntervalMinutes } from "./trading-loop.js";
import { createWorker, sendMessage as sendCommsMessage, DAVE_PARTICIPANT_ID } from "@dave/workers";
import { setBusy, clearBusy, getBusyState } from "./busy-state.js";
import { setPendingDelegation, getPendingDelegation, buildDelegationPrompt } from "./delegation.js";
import { loadConversationHistory, saveConversationHistory } from "./conversation-store.js";
import { dispatchCommand, dispatchCallback, tryHandlePendingModelEntry, tryHandlePendingVoiceEntry, tryHandlePendingKeyEntry, tryHandlePendingTtsKeyEntry, tryHandlePendingE2BKeyEntry, tryHandlePendingLimitEntry, tryHandlePendingTrailingEntry, tryHandlePendingApprovalReply, type CommandRouterDeps } from "./command-router.js";
import { recordActiveChat } from "./primary-chat.js";
import { wireMorningBrief } from "./morning-brief-handler.js";
import { wireFeedbackLoop } from "./feedback-loop-handler.js";
import { friendlyErrorMessage, AllConfiguredProvidersFailedError } from "./error-messages.js";

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
  botToken: string;
  publicBaseUrl: string;
  systemPrompt: string;
}

/**
 * Tries the user's configured primary provider, then their configured fallbacks, via their own
 * stored keys. Item 4/6 real gap fixed: a dying key or an exhausted provider used to fail over
 * silently -- the user never knew a switch happened, and a genuine "ran out of credit" looked
 * identical to any other transient hiccup. `notify` is real: it sends a real Telegram message the
 * moment a key switch or a provider exhaustion genuinely happens, mid-request, without dropping
 * the in-flight response the user is waiting for.
 */
/**
 * Real gap fixed (user: "should show the errors from the endpoint so I will confirm it, not you
 * saying it"): every failover/exhaustion notification below now includes the actual raw reason
 * string generateWithKeyFailover captured from the real API response (an HTTP status + body, or
 * the underlying fetch error) -- not just Dave's own paraphrase ("ran out of credit"). The
 * paraphrase stays as a quick-read label; the real endpoint text rides alongside it so the user
 * can verify it themselves instead of taking Dave's word for it.
 */
function modelConfigProvider(db: DaveDatabase, userId: string, notify: (text: string) => void | Promise<void>): Provider {
  return {
    name: "model-config" as ProviderName,
    async generate(req: CompletionRequest, timeoutMs: number): Promise<CompletionResult> {
      const config = getModelConfig(userId);
      const order = [config.primary, ...config.fallback.filter((p) => p !== config.primary)];
      const attempts: { provider: ProviderName; reason: string }[] = [];
      for (let p = 0; p < order.length; p++) {
        const provider = order[p];
        try {
          return await generateWithKeyFailover(db, userId, provider, req, timeoutMs, {
            onKeySwitch: async ({ fromIndex, toIndex, nextLabel, reason, quotaExhausted }) => {
              await notify(`🔄 Switched from key #${fromIndex} to key #${toIndex} (${nextLabel}) on ${provider} — key #${fromIndex} ${quotaExhausted ? "ran out of credit" : "failed"}. Real error: ${reason}`);
            },
            onProviderExhausted: async ({ reason, quotaExhausted }) => {
              attempts.push({ provider, reason });
              const nextProvider = order[p + 1];
              if (quotaExhausted) {
                await notify(`⚠️ ${provider} ran out of credit${nextProvider ? ` — switching to the next available key/provider (${nextProvider})` : " — no fallback provider is configured"}. Real error: ${reason}`);
              } else if (!nextProvider) {
                await notify(`⚠️ ${provider} failed and no fallback provider is configured. Real error: ${reason}`);
              }
            },
          });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          if (!attempts.some((a) => a.provider === provider)) attempts.push({ provider, reason });
        }
      }
      throw new AllConfiguredProvidersFailedError(attempts);
    },
  };
}

export interface TelegramBotServer {
  server: Server;
  webhookUrl: string;
}

/** The real, shared agent-turn path -- both a normal incoming message AND the "Pause and do it
 * myself" delegation button run through this exact function, so there is no second, divergent
 * way a message actually gets processed. Brackets the real run with setBusy()/clearBusy() so a
 * genuinely concurrent second message can detect it and ask (see the delegation flow above). */
async function runAgentTurn(
  deps: TelegramBotServerDeps,
  client: TelegramClient,
  chatId: number,
  historyKey: string,
  userContent: string | ContentBlock[],
  messageText: string | undefined
): Promise<void> {
  const registry = getOrBuildRegistry(deps, client, chatId);
  const provider = modelConfigProvider(deps.db, deps.ownerUserId, async (text) => { await client.sendMessage({ chat_id: chatId, text }); });
  const loop = new AgentLoop(provider, registry);

  let history = loadConversationHistory(deps.db, historyKey);
  if (history.length === 0) history = [{ role: "system", content: deps.systemPrompt }];

  // Real bug fixed: ask_user (ask-user.ts) genuinely pauses the loop and its question
  // WAS being sent to the user, but nothing ever resumed the paused run -- the next
  // message just started a fresh loop.run() over history that still had a dangling
  // assistant tool_call with no matching tool_result, which every real provider's API
  // rejects as malformed. Confirmed via this exact code path having no getPendingQuestion/
  // resume() reference anywhere. Now: if a question is genuinely pending for this owner,
  // this message IS the real answer -- resume the exact paused call, not a fresh turn.
  const pendingQuestion = messageText ? getPendingQuestion(deps.ownerUserId) : undefined;
  const pendingToolCallId = pendingQuestion ? findPendingAskUserToolCallId(history) : undefined;

  const taskDescription = typeof userContent === "string" ? userContent.slice(0, 80) : "processing your message";
  setBusy(deps.ownerUserId, taskDescription);
  try {
    let finalResult: AgentRunResult | undefined;
    await withThinkingIndicator(client, chatId, async (indicator) => {
      const onStep = (step: AgentStep) => void indicator.update(classifyToolAction(step.toolName), step.toolName);
      let result: AgentRunResult;
      if (pendingQuestion && pendingToolCallId) {
        clearPendingQuestion(deps.ownerUserId);
        result = await loop.resume({ status: "awaiting_user", question: pendingQuestion, toolCallId: pendingToolCallId, history, steps: [] }, messageText as string, { maxSteps: 8, onStep });
      } else {
        history.push({ role: "user", content: userContent });
        result = await loop.run(history, { maxSteps: 8, onStep });
      }
      saveConversationHistory(deps.db, historyKey, result.history);
      finalResult = result;
      const rawFinalText = result.status === "done" ? result.text || "(no text)" : result.question.question;
      const finalText = markdownToTelegramHtml(rawFinalText);
      return { result: undefined, finalText };
    });
    // Real gap fixed (item 7: "inline-button-based questions Dave asks aren't being
    // received/processed correctly") -- ask_user previously had no way to offer clickable
    // choices at all. When the paused question carries real options, send them as real inline
    // buttons (askuser:<toolCallId>:<index>) in a follow-up message; tapping one is handled
    // below in the real callback_query path, resuming the SAME paused loop exactly like a typed
    // answer would.
    if (finalResult?.status === "awaiting_user" && finalResult.question.options && finalResult.question.options.length > 0) {
      const options = finalResult.question.options;
      const toolCallId = finalResult.toolCallId;
      const rows = options.map((opt, i) => [{ text: opt, callback_data: `askuser:${toolCallId}:${i}` }]);
      await client.sendMessage({ chat_id: chatId, text: "Tap an option:", reply_markup: { inline_keyboard: rows } });
    }
  } catch (err) {
    await client.sendMessage({ chat_id: chatId, text: friendlyErrorMessage(err) });
  } finally {
    clearBusy(deps.ownerUserId);
  }
}

/**
 * The single real handler for /stop, /panic, /start_trading, /stop_trading -- shared between the
 * typed-text path (checked first thing, before anything else) and the /menu button-tap path
 * (menucmd:start_trading etc in the callback_query handler below), so a tap does exactly the
 * same real thing as typing the command, not a second divergent path. Returns true if `text`
 * was one of these and was handled (caller should not do anything else with it).
 */
async function handleTradingControlCommand(deps: TelegramBotServerDeps, client: TelegramClient, chatId: number, text: string): Promise<boolean> {
  if (/^\/(stop|panic)\b/i.test(text)) {
    stopOrPanic(deps.ownerUserId, text.toLowerCase().startsWith("/panic") ? "panic" : "stop");
    stopAutonomousTradingLoop(deps.ownerUserId);
    await client.sendMessage({ chat_id: chatId, text: "🛑 Stopped -- all trading and workers halted immediately." });
    return true;
  }

  // Real gap fixed (user: "every 5 min -- make this settable and configurable"): an optional
  // trailing number of minutes, e.g. "/start_trading 10", sets the real persisted cadence
  // (trading-loop-config.ts). Works whether the loop is currently off (starts it at that
  // cadence) or already running (re-arms it live at the new cadence, no stop/start needed).
  const startTradingMatch = text.match(/^\/start_trading(?:\s+(\d+))?\s*$/i);
  if (startTradingMatch) {
    const requestedMinutes = startTradingMatch[1] ? Number(startTradingMatch[1]) : undefined;
    if (requestedMinutes !== undefined) {
      try {
        setAutonomousTradingIntervalMinutes(deps.ownerUserId, requestedMinutes);
      } catch (err) {
        await client.sendMessage({ chat_id: chatId, text: err instanceof Error ? err.message : String(err) });
        return true;
      }
    }
    const wasAlreadyRunning = isAutonomousTradingRunning(deps.ownerUserId);
    const started = startAutonomousTradingLoop(deps.ownerUserId, () => runAutonomousTradingCycle(deps, client, chatId));
    const interval = getTradingLoopIntervalMinutes(deps.ownerUserId);
    let replyText: string;
    if (started) {
      replyText = `▶️ Autonomous trading is on (cadence: every ${interval} min). I'll scan my active pair group and act on real setups on my own initiative -- I'll only message you when something actually happens (a trade, a TP/SL hit, or a real question). /stop_trading turns this off, /stop or /panic is still the instant hard kill. Change the cadence any time with /start_trading <minutes>, or from /settings.`;
    } else if (requestedMinutes !== undefined && wasAlreadyRunning) {
      replyText = `🔄 Autonomous trading cadence updated to every ${interval} min, applied immediately.`;
    } else {
      replyText = `Autonomous trading is already running (cadence: every ${interval} min).`;
    }
    await client.sendMessage({ chat_id: chatId, text: replyText });
    return true;
  }
  if (/^\/stop_trading\b/i.test(text)) {
    const stopped = stopAutonomousTradingLoop(deps.ownerUserId);
    await client.sendMessage({ chat_id: chatId, text: stopped ? "⏸️ Autonomous trading is off. I'll still help directly whenever you message me." : "Autonomous trading wasn't running." });
    return true;
  }
  return false;
}

/** The real per-tick body of /start_trading's autonomous loop (see trading-loop.ts for the
 * scheduling itself). Deliberately runs against its OWN, separate conversation history
 * (`<owner>:autonomous:<chatId>`) rather than the user's real chat thread -- an autonomous
 * scan's internal back-and-forth isn't something the user should see mixed into their own
 * conversation later, even though it shares the exact same tools/registry/system prompt (goal.yaml
 * included). Per IDENTITY.md's "trade quietly" rule, this sends NOTHING to the user unless the
 * model's own final text is real content -- a bare "NOTHING_TO_REPORT" sentinel (or empty text)
 * means a normal, quiet cycle where nothing needed saying, and is swallowed here, never sent. */
async function runAutonomousTradingCycle(deps: TelegramBotServerDeps, client: TelegramClient, chatId: number): Promise<void> {
  if (isTradingHalted(deps.ownerUserId)) return;
  if (getBusyState(deps.ownerUserId)) return; // a real user turn is already in flight -- don't collide with it, just wait for the next tick

  const historyKey = `${deps.ownerUserId}:autonomous:${chatId}`;
  const registry = getOrBuildRegistry(deps, client, chatId);
  const provider = modelConfigProvider(deps.db, deps.ownerUserId, async (text) => {
    await client.sendMessage({ chat_id: chatId, text });
  });
  const loop = new AgentLoop(provider, registry);

  let history = loadConversationHistory(deps.db, historyKey);
  if (history.length === 0) history = [{ role: "system", content: deps.systemPrompt }];
  history.push({
    role: "user",
    content:
      "[Autonomous trading cycle -- not a message from the user, do not treat it as one] Scan your active pair group for a genuine setup using your real analysis tools and goal.yaml rules, and act (open/manage a real trade) if one genuinely clears. If there is nothing worth reporting this cycle -- no trade opened/closed, no TP/SL hit, nothing you need to ask -- respond with exactly: NOTHING_TO_REPORT",
  });

  setBusy(deps.ownerUserId, "autonomous trading cycle");
  try {
    const result = await loop.run(history, { maxSteps: 8 });
    saveConversationHistory(deps.db, historyKey, result.history);
    if (result.status === "awaiting_user") {
      const finalText = markdownToTelegramHtml(result.question.question);
      if (result.question.options && result.question.options.length > 0) {
        const rows = result.question.options.map((opt, i) => [{ text: opt, callback_data: `askuser:${result.toolCallId}:${i}` }]);
        await client.sendMessage({ chat_id: chatId, text: finalText, parse_mode: "HTML" });
        await client.sendMessage({ chat_id: chatId, text: "Tap an option:", reply_markup: { inline_keyboard: rows } });
      } else {
        await client.sendMessage({ chat_id: chatId, text: finalText, parse_mode: "HTML" });
      }
      return;
    }
    const text = (result.text ?? "").trim();
    if (!text || text === "NOTHING_TO_REPORT") return;
    await client.sendMessage({ chat_id: chatId, text: markdownToTelegramHtml(text), parse_mode: "HTML" });
  } catch (err) {
    console.error(`[trading-loop] autonomous cycle failed for ${deps.ownerUserId}:`, err);
  } finally {
    clearBusy(deps.ownerUserId);
  }
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

        // Real gap fixed (mid-task delegation): the 3 real buttons a delegation prompt sends
        // need runAgentTurn/createWorker, which only this module (not command-router.ts) has
        // in scope -- intercepted here, before the generic dispatchCallback.
        const delegateData = update.callback_query.data ?? "";
        if (delegateData.startsWith("delegate:") && cbChatId !== undefined) {
          const pending = getPendingDelegation(deps.ownerUserId);
          setPendingDelegation(deps.ownerUserId, null);
          const action = delegateData.slice("delegate:".length);
          if (!pending) {
            await client.answerCallbackQuery({ callback_query_id: update.callback_query.id, text: "That request is no longer waiting" }).catch(() => undefined);
            return;
          }
          if (action === "skip") {
            await client.answerCallbackQuery({ callback_query_id: update.callback_query.id, text: "Skipped" }).catch(() => undefined);
            await client.sendMessage({ chat_id: pending.chatId, text: "Skipped -- let me know if you still need that." });
          } else if (action === "worker") {
            await client.answerCallbackQuery({ callback_query_id: update.callback_query.id, text: "Assigning a worker" }).catch(() => undefined);
            const worker = createWorker(deps.ownerUserId, { assignment: "temporary", role: "generic", task: pending.text });
            sendCommsMessage(deps.ownerUserId, DAVE_PARTICIPANT_ID, worker.id, pending.text);
            await client.sendMessage({ chat_id: pending.chatId, text: `Handed to ${worker.name} (#${worker.name.toLowerCase()}) -- I'll keep going on what I was doing.` });
          } else if (action === "pause") {
            await client.answerCallbackQuery({ callback_query_id: update.callback_query.id, text: "Pausing to handle it now" }).catch(() => undefined);
            await client.sendMessage({ chat_id: pending.chatId, text: "Pausing what I was doing -- on it now." });
            const historyKeyForPending = `${deps.ownerUserId}:${pending.chatId}`;
            await runAgentTurn(deps, client, pending.chatId, historyKeyForPending, pending.text, pending.text);
          }
          return;
        }

        // Real gap fixed (item 7: inline-button ask_user answers were never received/processed
        // -- this callback_data prefix had NO handler anywhere, so a tap silently did nothing).
        // Intercepted here (not in command-router's generic dispatchCallback) because resuming
        // the paused loop needs runAgentTurn, which only this module has in scope.
        const askUserData = update.callback_query.data ?? "";
        if (askUserData.startsWith("askuser:") && cbChatId !== undefined) {
          const [, toolCallId, indexStr] = askUserData.split(":");
          const pendingQuestion = getPendingQuestion(deps.ownerUserId);
          const historyKeyForAskUser = `${deps.ownerUserId}:${cbChatId}`;
          const history = loadConversationHistory(deps.db, historyKeyForAskUser);
          const actualToolCallId = findPendingAskUserToolCallId(history);
          if (!pendingQuestion || actualToolCallId !== toolCallId) {
            await client.answerCallbackQuery({ callback_query_id: update.callback_query.id, text: "That question is no longer waiting" }).catch(() => undefined);
            return;
          }
          const chosen = pendingQuestion.options?.[Number(indexStr)];
          if (chosen === undefined) {
            await client.answerCallbackQuery({ callback_query_id: update.callback_query.id, text: "That option expired -- please answer in a message" }).catch(() => undefined);
            return;
          }
          await client.answerCallbackQuery({ callback_query_id: update.callback_query.id, text: `Picked: ${chosen}` }).catch(() => undefined);
          await client.sendMessage({ chat_id: cbChatId, text: `You picked: ${chosen}` });
          await runAgentTurn(deps, client, cbChatId, historyKeyForAskUser, chosen, chosen);
          return;
        }

        // Real gap fixed (user: "/start_trading, /stop_trading, /panic should be... added to the
        // menu UI"): the /menu screen's buttons for these tap through as menucmd:<command> --
        // routed to the exact same real handler the typed command uses (handleTradingControlCommand),
        // not the generic command-router switch (which has no case for these three; the real
        // logic lives only here, where the live autonomous-cycle closure/runAgentTurn are in scope).
        const menuCmdData = update.callback_query.data ?? "";
        if (/^menucmd:(start_trading|stop_trading|stop|panic)$/.test(menuCmdData) && cbChatId !== undefined) {
          const command = menuCmdData.slice("menucmd:".length);
          await client.answerCallbackQuery({ callback_query_id: update.callback_query.id }).catch(() => undefined);
          await handleTradingControlCommand(deps, client, cbChatId, `/${command}`);
          return;
        }

        const routerDeps: CommandRouterDeps = { db: deps.db, client, userId: deps.ownerUserId, publicBaseUrl: deps.publicBaseUrl, davema: deps.davema };
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

      // Real gap fixed: SECURITY.md documents "/stop or /panic from the user is an instant,
      // unconditional halt" as if these were real commands. Also covers /start_trading and
      // /stop_trading (the real autonomous-cycle on/off switch). Checked FIRST, before command
      // dispatch and everything else, so none of these can ever be delayed behind any other
      // handling -- and shared with the /menu button-tap path below (handleTradingControlCommand),
      // so tapping ▶️ Start trading does exactly the same real thing as typing it.
      if (message.text && (await handleTradingControlCommand(deps, client, chatId, message.text.trim()))) {
        return;
      }

      // Real fix (A2): the 9 slash commands used to fall straight
      // through to the LLM like any other message -- no live router
      // ever intercepted them. dispatchCommand() handles all 9 for
      // real (including /reset -> clearConversationHistory()) and
      // returns true when it did, so a recognized command never
      // reaches the agent loop below.
      if (message.text && isDaveCommand(message.text)) {
        const routerDeps: CommandRouterDeps = { db: deps.db, client, userId: deps.ownerUserId, publicBaseUrl: deps.publicBaseUrl, davema: deps.davema };
        const handled = await dispatchCommand(routerDeps, chatId, historyKey, message.text);
        if (handled) return;
      }

      // Real fix ("fetch the models like v1 model so I can select as well"): /models on a
      // manual-entry provider (OpenRouter/OrcaRouter/HuggingFace) asks the user to reply with
      // the model ID as their next message -- this is that capture, checked before anything
      // free-text falls through to the LLM.
      if (message.text) {
        const routerDeps: CommandRouterDeps = { db: deps.db, client, userId: deps.ownerUserId, publicBaseUrl: deps.publicBaseUrl, davema: deps.davema };
        if (await tryHandlePendingModelEntry(routerDeps, chatId, message.text)) return;
        if (await tryHandlePendingVoiceEntry(routerDeps, chatId, message.text)) return;
        if (await tryHandlePendingKeyEntry(routerDeps, chatId, message.text)) return;
        if (await tryHandlePendingTtsKeyEntry(routerDeps, chatId, message.text)) return;
        if (await tryHandlePendingE2BKeyEntry(routerDeps, chatId, message.text)) return;
        if (await tryHandlePendingLimitEntry(routerDeps, chatId, message.text)) return;
        if (await tryHandlePendingTrailingEntry(routerDeps, chatId, message.text)) return;
        // Item 11: a typed "yes"/"no" answering a real pending settings-change approval is
        // handled here, BEFORE the agent loop ever sees it -- otherwise the model has no way
        // to know an approval is already pending and could re-propose the same change, sending
        // a SECOND UI prompt on top of the first real one.
        if (await tryHandlePendingApprovalReply(routerDeps, chatId, message.text)) return;
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
          console.error("[telegram-bot-server] failed to process attachment:", err);
          await client.sendMessage({ chat_id: chatId, text: "⚠️ Couldn't process that attachment. Try again in a moment." });
          return;
        }
      }

      // Real gap fixed (user: "Dave doesn't just silently switch or silently ignore" a new
      // request that arrives while busy with something else). Checked only for genuinely
      // concurrent overlap -- setBusy()/clearBusy() bracket the real agent-loop run below, so
      // this is only ever true if a second webhook delivery lands while the first is still
      // in flight, not on every message.
      const busy = message.text ? getBusyState(deps.ownerUserId) : null;
      if (busy && message.text) {
        setPendingDelegation(deps.ownerUserId, { text: message.text, chatId });
        const prompt = buildDelegationPrompt(busy);
        await client.sendMessage({ chat_id: chatId, text: prompt.text, reply_markup: prompt.reply_markup });
        return;
      }

      await runAgentTurn(deps, client, chatId, historyKey, userContent, message.text);
    },
  });

  return { server, webhookUrl: `${deps.publicBaseUrl}${registration.path}` };
}
