import { randomBytes } from "node:crypto";
import type { DaveDatabase } from "@dave/db";
import type { ContentBlock } from "@dave/brain";
import type { TelegramClient } from "@dave/telegram";
import type { TradeExecutor } from "@dave/trading";
import { resetConsolidationFailures } from "@dave/memory";
import { AgentLoop, type AgentRunResult } from "./agent-loop.js";
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
import { saveAppFile } from "./app-files.js";
import { chatEventPublisher } from "./activity-events.js";
import { loadSystemPrompt } from "./system-prompt.js";
import { autoSaveMemory } from "./memory-autosave.js";
import { resumeUnfinishedTodos } from "./todos.js";

export { toolLabel, chatEventPublisher } from "./activity-events.js";

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

type SinkMessage = { chat_id?: unknown; text?: string; rich_message?: { blocks?: unknown[]; html?: string; markdown?: string }; parse_mode?: string };

/**
 * A stand-in for the Telegram client, for tools running on behalf of the app: messages they send
 * become `message` events in the app's chat; anything Telegram-only answers with a clear error.
 */
export function createAppSink(userId: string, currentTurn: () => { turnId?: string; channel: ActivityChannel }): TelegramClient {
  let nextMessageId = 1;
  const post = (kind: string, data: Record<string, unknown>) => {
    const { turnId, channel } = currentTurn();
    const messageId = nextMessageId++;
    // A new message carries its id, so a later edit/delete of it can find it in the app.
    publishActivity(userId, "chat", kind, kind === "message" ? { ...data, id: messageId } : data, { turnId, channel });
    return { message_id: messageId };
  };
  const handlers: Record<string, (params: SinkMessage & Record<string, unknown>) => unknown> = {
    sendMessage: (p) => post("message", { text: p.text ?? "", format: p.parse_mode === "HTML" ? "html" : "text", buttons: p.reply_markup }),
    sendRichMessage: (p) => post("message", { blocks: p.rich_message?.blocks, html: p.rich_message?.html, markdown: p.rich_message?.markdown, buttons: p.reply_markup }),
    sendRichMessageDraft: () => true,
    editMessageText: (p) => post("message_edit", { messageId: p.message_id, text: p.text ?? "" }),
    editMessageReplyMarkup: () => ({ message_id: 0 }),
    deleteMessage: (p) => (post("message_delete", { messageId: p.message_id }), true),
    sendChatAction: () => true,
    sendDrawing: (p) => post("drawing", { drawing: p.drawing, caption: p.caption }),
    setMessageReaction: (p) => (post("reaction", { messageId: p.message_id, reaction: p.reaction }), true),
    // Files Dave sends (send_file_to_user, a chart, an export) become file cards in the chat.
    sendDocument: (p) => postFile(p.document, p.caption as string | undefined, "file"),
    sendPhoto: (p) => postFile(p.photo, p.caption as string | undefined, "photo.png"),
  };
  const postFile = (input: unknown, caption: string | undefined, fallbackName: string) => {
    const f = input as { buffer?: Buffer; filename?: string } | string | undefined;
    if (!f || typeof f === "string" || !f.buffer) throw new Error("In the app, send the file's content itself (send_file_to_user), not a Telegram file id or URL.");
    const saved = saveAppFile(userId, f.filename ?? fallbackName, Buffer.from(f.buffer));
    return post("file", { ...saved, caption: caption ?? null });
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

export function appRegistry(deps: AppChatDeps): ToolRegistry {
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
  /** What the chat bubble shows when it differs from what Dave reads (files attached). */
  display?: { text: string; files: string[] };
}

/**
 * One app turn. Resolves when the turn is over; every step has been published by then. The caller
 * (the route) has already checked Dave isn't busy.
 */
export async function runAppChatTurn(deps: AppChatDeps, input: AppChatInput, turnId = newTurnId(), loopFactory = (d: AppChatDeps) => new AgentLoop(modelProvider(d), appRegistry(d))): Promise<AgentRunResult | undefined> {
  const { userId, db } = deps;
  const extra = { turnId, channel: "app" as const };
  const turnStartedAt = Date.now();
  publishActivity(userId, "chat", "user_message", { text: input.display?.text ?? input.text, images: input.images?.length ?? 0, ...(input.display?.files.length ? { files: input.display.files } : {}) }, extra);
  publishActivity(userId, "chat", "turn_start", {}, extra);

  const historyKey = sharedHistoryKey(db, userId);
  let history = loadConversationHistory(db, historyKey);
  // Always the CURRENT prompt: the stored conversation keeps its first system message forever, so
  // without this a prompt fix (or an edit from the app) would never reach an ongoing chat.
  if (history.length === 0) history = [{ role: "system", content: loadSystemPrompt() }];
  else if (history[0].role === "system") history[0] = { role: "system", content: loadSystemPrompt() };
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
    // A multi-part request whose to-do list isn't finished carries on by itself (todos.ts).
    result = await resumeUnfinishedTodos(userId, turnStartedAt, result, (h) => loop.run(h, { signal: controller.signal, onEvent }), (r, progress) => {
      saveConversationHistory(db, historyKey, r.history);
      const said = r.status === "done" ? r.text.trim() : "";
      publishActivity(userId, "chat", "notice", { text: `${said ? `${said}\n\n` : ""}To-do list ${progress} done -- carrying on with the rest.` }, extra);
    });
    saveConversationHistory(db, historyKey, result.history);
    publishFinal(userId, turnId, "app", result);
    if (result.status === "done") {
      // Off the reply's path: save anything lasting the trader just said (memory-autosave.ts).
      void autoSaveMemory(modelConfigProvider(db, userId, () => undefined, "background"), userId, { userText: input.text, replyText: result.text, steps: result.steps }).then((saved) => {
        if (saved.length) publishActivity(userId, "background", "memory", { text: `🧠 Saved to memory: ${saved.join(" · ")}` });
      });
    }
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
