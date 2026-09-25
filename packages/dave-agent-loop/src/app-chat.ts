import { randomBytes } from "node:crypto";
import type { DaveDatabase } from "@dave/db";
import type { ContentBlock } from "@dave/brain";
import type { TelegramClient } from "@dave/telegram";
import type { TradeExecutor } from "@dave/trading";
import { resetConsolidationFailures } from "@dave/memory";
import { AgentLoop, type AgentEvent, type AgentRunResult } from "./agent-loop.js";
import { buildFullToolRegistry } from "./full-registry.js";
import type { ToolRegistry } from "./tool-registry.js";
import { modelConfigProvider } from "./provider-selection.js";
import { loadConversationHistory, saveConversationHistory } from "./conversation-store.js";
import { withLiveContext } from "./live-context.js";
import { getPendingQuestion, clearPendingQuestion, findPendingAskUserToolCallId } from "./ask-user.js";
import { setBusy, clearBusy } from "./busy-state.js";
import { beginTurn, endTurn, abortTurn } from "./turn-abort.js";
import { friendlyErrorMessage } from "./error-messages.js";
import { getPrimaryChatId } from "./primary-chat.js";
import { publishActivity, type ActivityChannel } from "./activity-bus.js";

/**
 * Dave in the phone app (the trader: "build the chatting in the application -- the input and output,
 * the subtasks, see the tool calling, the thinking"). Same Dave as Telegram: same tools, same AI,
 * and the SAME conversation (history key shared with the Telegram chat), so a question asked in one
 * can be followed up in the other. Every step goes to the activity bus, which the app streams.
 *
 * The tools that normally put a message in Telegram (send_telegram, tg_rich_blocks, ...) are handed
 * an app sink instead: their messages become chat events in the app, rich tables included.
 */

export interface AppChatDeps {
  userId: string;
  db: DaveDatabase;
  executor: TradeExecutor;
  systemPrompt: string;
  publicBaseUrl?: string;
}

/** Not a real Telegram chat -- the app sink's chat id. */
export const APP_CHAT_ID = 0;

/** The conversation both channels share: the Telegram chat's key once Telegram is paired. */
export function sharedHistoryKey(db: DaveDatabase, userId: string): string {
  const chatId = getPrimaryChatId(db, userId);
  return chatId !== undefined ? `${userId}:${chatId}` : `${userId}:app`;
}

export function newTurnId(): string {
  return randomBytes(6).toString("hex");
}

/** Plain-words label for a tool, for the live "Dave is working" card. */
export function toolLabel(name: string): string {
  if (name === "run_script") return "Running a script";
  if (name === "search_tools") return "Looking for the right tool";
  if (name.startsWith("get_")) return `Checking ${name.slice(4).replace(/_/g, " ")}`;
  if (name === "find_setup" || name === "hunt_for_setup") return "Hunting for a setup";
  if (name.startsWith("trade_") || name === "full_close" || name === "partial_close" || name === "modify_sl_tp") return name.replace(/_/g, " ");
  if (name.startsWith("tg_") || name === "send_telegram") return "Writing a message";
  if (name === "create_subagent") return "Starting a worker";
  return name.replace(/_/g, " ");
}

/** AgentLoop events -> the activity bus, for any channel. */
export function chatEventPublisher(userId: string, turnId: string, channel: ActivityChannel, agent?: string): (e: AgentEvent) => void {
  return (e) => {
    const extra = { turnId, channel, agent };
    if (e.type === "tool_start") publishActivity(userId, "chat", "tool_start", { id: e.id, name: e.name, label: toolLabel(e.name), args: e.args }, extra);
    else if (e.type === "tool_end") publishActivity(userId, "chat", "tool_end", { id: e.id, name: e.name, label: toolLabel(e.name), result: e.result, isError: e.isError, ms: e.ms }, extra);
    else if (e.type === "text") publishActivity(userId, "chat", "text", { text: e.text }, extra);
    else publishActivity(userId, "chat", "thinking", { text: e.text }, extra);
  };
}

type SinkMessage = { chat_id?: unknown; text?: string; rich_message?: { blocks?: unknown[]; html?: string }; parse_mode?: string };

/**
 * A stand-in for the Telegram client, for tools running on behalf of the app: messages they send
 * become `message` events in the app's chat; anything Telegram-only answers with a clear error.
 */
export function createAppSink(userId: string, currentTurn: () => { turnId?: string; channel: ActivityChannel }): TelegramClient {
  let nextMessageId = 1;
  const post = (kind: string, data: Record<string, unknown>) => {
    const { turnId, channel } = currentTurn();
    publishActivity(userId, "chat", kind, data, { turnId, channel });
    return { message_id: nextMessageId++ };
  };
  const handlers: Record<string, (params: SinkMessage & Record<string, unknown>) => unknown> = {
    sendMessage: (p) => post("message", { text: p.text ?? "", format: p.parse_mode === "HTML" ? "html" : "text", buttons: p.reply_markup }),
    sendRichMessage: (p) => post("message", { blocks: p.rich_message?.blocks, html: p.rich_message?.html, buttons: p.reply_markup }),
    sendRichMessageDraft: () => true,
    editMessageText: (p) => post("message_edit", { messageId: p.message_id, text: p.text ?? "" }),
    editMessageReplyMarkup: () => ({ message_id: 0 }),
    deleteMessage: (p) => (post("message_delete", { messageId: p.message_id }), true),
    sendChatAction: () => true,
    setMessageReaction: (p) => (post("reaction", { messageId: p.message_id, reaction: p.reaction }), true),
  };
  return new Proxy({} as TelegramClient, {
    get(_t, prop: string) {
      if (prop === "then") return undefined; // not a promise
      const handler = handlers[prop];
      if (handler) return async (params: Record<string, unknown>) => handler(params as SinkMessage & Record<string, unknown>);
      return async () => {
        throw new Error(`"${prop}" works in Telegram only -- in the app, just answer in the reply.`);
      };
    },
  });
}

const registryCache = new Map<string, ToolRegistry>();
const appTurnState = new Map<string, { turnId?: string; channel: ActivityChannel }>();

function appRegistry(deps: AppChatDeps): ToolRegistry {
  let registry = registryCache.get(deps.userId);
  if (!registry) {
    const sink = createAppSink(deps.userId, () => appTurnState.get(deps.userId) ?? { channel: "app" });
    registry = buildFullToolRegistry({ userId: deps.userId, db: deps.db, executor: deps.executor, telegram: { client: sink, chatId: APP_CHAT_ID }, publicBaseUrl: deps.publicBaseUrl });
    registryCache.set(deps.userId, registry);
  }
  return registry;
}

export interface AppChatInput {
  text: string;
  images?: ContentBlock[];
}

/**
 * One app turn. Resolves when the turn is over; every step has been published by then. The caller
 * (the route) has already checked Dave isn't busy.
 */
export async function runAppChatTurn(deps: AppChatDeps, input: AppChatInput, turnId = newTurnId(), loopFactory = (d: AppChatDeps) => new AgentLoop(modelProvider(d), appRegistry(d))): Promise<AgentRunResult | undefined> {
  const { userId, db } = deps;
  const extra = { turnId, channel: "app" as const };
  publishActivity(userId, "chat", "user_message", { text: input.text, images: input.images?.length ?? 0 }, extra);
  publishActivity(userId, "chat", "turn_start", {}, extra);

  const historyKey = sharedHistoryKey(db, userId);
  let history = loadConversationHistory(db, historyKey);
  if (history.length === 0) history = [{ role: "system", content: deps.systemPrompt }];
  const pendingQuestion = input.text ? getPendingQuestion(userId) : undefined;
  const pendingToolCallId = pendingQuestion ? findPendingAskUserToolCallId(history) : undefined;

  // A new message stops the app's previous turn and any background tick -- never a Telegram reply.
  abortTurn(userId, { except: "telegram" });
  setBusy(userId, `(app) ${input.text.slice(0, 80) || "a picture"}`);
  resetConsolidationFailures(userId);
  const controller = beginTurn(userId, "app");
  appTurnState.set(userId, extra);
  try {
    const loop = loopFactory(deps);
    const onEvent = chatEventPublisher(userId, turnId, "app");
    let result: AgentRunResult;
    if (pendingQuestion && pendingToolCallId) {
      clearPendingQuestion(userId);
      result = await loop.resume({ status: "awaiting_user", question: pendingQuestion, toolCallId: pendingToolCallId, history, steps: [] }, input.text, { signal: controller.signal, onEvent });
    } else {
      const content: string | ContentBlock[] = input.images?.length ? [{ type: "text", text: input.text || "(see the picture)" }, ...input.images] : input.text;
      history.push({ role: "user", content: withLiveContext(userId, content) });
      result = await loop.run(history, { signal: controller.signal, onEvent });
    }
    saveConversationHistory(db, historyKey, result.history);
    publishFinal(userId, turnId, "app", result);
    return result;
  } catch (err) {
    publishActivity(userId, "chat", "error", { message: friendlyErrorMessage(err) }, extra);
    return undefined;
  } finally {
    endTurn(userId, controller);
    clearBusy(userId);
    appTurnState.delete(userId);
  }
}

/** The end of a turn, for either channel: the reply, a question with options, or why it stopped. */
export function publishFinal(userId: string, turnId: string, channel: ActivityChannel, result: AgentRunResult): void {
  const extra = { turnId, channel };
  const usage = result.tokenUsage ? { totalTokens: result.tokenUsage.totalTokens, cachedTokens: result.tokenUsage.cacheReadInputTokens } : undefined;
  if (result.status === "awaiting_user") {
    publishActivity(userId, "chat", "ask_user", { question: result.question.question, options: result.question.options ?? [], toolCallId: result.toolCallId, usage }, extra);
  } else if (result.status === "aborted") {
    publishActivity(userId, "chat", "final", { text: result.reason === "deadline" ? "That took longer than I could keep going on this turn -- try again, or ask for something narrower." : "Stopped.", stopped: result.reason, usage }, extra);
  } else {
    const last = result.steps.at(-1);
    const ownMessage = !!last && !last.isError && /^(send_telegram|tg_rich_message|tg_rich_blocks|reply_to_message)$/.test(last.toolName);
    publishActivity(userId, "chat", "final", { text: ownMessage ? "" : result.text || "Done.", usage }, extra);
  }
}

function modelProvider(deps: AppChatDeps) {
  return modelConfigProvider(deps.db, deps.userId, (text) => {
    const state = appTurnState.get(deps.userId);
    publishActivity(deps.userId, "chat", "notice", { text }, { turnId: state?.turnId, channel: "app" });
  }, "chat");
}
