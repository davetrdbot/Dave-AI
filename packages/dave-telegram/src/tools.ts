import type { TelegramClient } from "./client.js";
import { ThinkingIndicator } from "./thinking-indicator.js";
import { markdownToTelegramHtml } from "./rich-format.js";
import { getOrCreateUserWebhook } from "@dave/memory";
import { personalizeEaFile } from "./ea-file.js";
import { updateBotDisplayInfo } from "./profile.js";
import { registerDefaultCommandMenu } from "./menu.js";

/**
 * Update 18 (bulk tool-coverage expansion): Step 8/9/15's real
 * Telegram capabilities (rich formatting, the thinking indicator, file
 * delivery, menu/profile management) had almost no agent-tool surface
 * -- `push_message_to_user` (Update 14) was the only one.
 */
export interface TelegramToolContext {
  client: TelegramClient;
  chatId: number;
}

export interface TelegramToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: TelegramToolContext) => Promise<unknown>;
}

// Reinstated (explicit trader reversal of the 1b21a73 removal, confirmed live): tg_thinking/
// tg_thinking_update/tg_finalize are model-callable again. 1b21a73's real bug was never "these
// tools shouldn't exist" -- it was that they raced against a SECOND, automatic indicator
// (`withThinkingIndicator`/`runAgentTurn` in telegram-bot-server.ts) that every chat turn also
// got, with zero AI decision involved. Two independent `ThinkingIndicator` instances per turn is
// what produced the duplicate/orphaned message, not the model-callable tools themselves.
//
// The trader wants exactly this back: Dave decides for itself, per IDENTITY.md guidance, when a
// task is worth narrating -- not every turn gets an indicator automatically. Fixed for real this
// time by removing the OTHER side of the race instead: `withThinkingIndicator` is no longer
// called automatically by runAgentTurn (see telegram-bot-server.ts) -- these three tools are now
// the ONLY path that can ever create/update/finalize a `ThinkingIndicator`. If the model never
// calls `tg_thinking`, no indicator is created at all, and the turn's final answer just sends as
// a plain message, exactly as before this feature existed.
//
// One indicator per active turn/chat, enforced here via `activeIndicators` (keyed by chatId, same
// as the original pre-1b21a73 shape) -- a second `tg_thinking` call in the same turn (e.g. the
// model narrating a new phase of a long task) is treated as an update on the SAME indicator
// rather than creating a second one, so it can never race or duplicate.
const activeIndicators = new Map<number, ThinkingIndicator>();

/** Real safety net (telegram-bot-server.ts's runAgentTurn calls this on every turn's exit path,
 *  success/abort/error alike): if the model opened an indicator via tg_thinking but never reached
 *  tg_finalize (an exception mid-turn, a forgotten close, etc), this is how the caller finds it to
 *  clean it up rather than leaving a "thinking..." message stuck in the chat forever. */
export function getActiveIndicator(chatId: number): ThinkingIndicator | undefined {
  return activeIndicators.get(chatId);
}

/** Clears the tracked indicator for a chat without touching Telegram -- call after the caller has
 *  itself finalized/cleaned up the real message (or decided there's nothing worth sending). */
export function clearActiveIndicator(chatId: number): void {
  activeIndicators.delete(chatId);
}

export const TELEGRAM_TOOLS: TelegramToolDefinition[] = [
  {
    name: "tg_thinking",
    description:
      "Open a live 'thinking...' indicator in the chat, describing what you're about to do (e.g. 'Scanning 8 pairs for a setup'). " +
      "Use only for multi-step work the user is actively waiting on -- not every message, never during silent autonomous cycles. " +
      "Calling this again in the same turn just updates the same indicator, it never opens a second one.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    execute: async (args, ctx) => {
      const text = args.text as string;
      const existing = activeIndicators.get(ctx.chatId);
      if (existing) {
        // Already have a live indicator for this chat/turn -- treat a second tg_thinking as an
        // update rather than opening a duplicate one (see the class-level comment above).
        await existing.update("worker", text);
        return { ok: true, reused: true };
      }
      const indicator = new ThinkingIndicator(ctx.client, ctx.chatId);
      activeIndicators.set(ctx.chatId, indicator);
      await indicator.start();
      await indicator.update("worker", text);
      return { ok: true };
    },
  },
  {
    name: "tg_thinking_update",
    description: "Update the live thinking indicator's text to show your real next step (e.g. 'Checking XAUUSD H4 structure...'). Requires tg_thinking to have been called first this turn.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    execute: async (args, ctx) => {
      const indicator = activeIndicators.get(ctx.chatId);
      if (!indicator) throw new Error("no active thinking indicator for this chat -- call tg_thinking first");
      await indicator.update("worker", args.text as string);
      return { ok: true };
    },
  },
  {
    name: "tg_finalize",
    description: "Replace the thinking indicator with your real final response. Requires tg_thinking to have been called first this turn.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    execute: async (args, ctx) => {
      const indicator = activeIndicators.get(ctx.chatId);
      if (!indicator) throw new Error("no active thinking indicator for this chat -- call tg_thinking first");
      // Real gap fixed (item 2, "raw HTML tags visible to the user"): finalize() sends real HTML
      // via sendMessage's parse_mode: "HTML" -- text reaching it must already be real converted
      // HTML, same as every other real final-answer path (telegram-bot-server.ts), not raw
      // markdown/model-written tags.
      await indicator.finalize(markdownToTelegramHtml(args.text as string));
      activeIndicators.delete(ctx.chatId);
      return { ok: true };
    },
  },
  {
    name: "send_telegram",
    description: "Send a plain real Telegram message.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    execute: async (args, ctx) => ctx.client.sendMessage({ chat_id: ctx.chatId, text: markdownToTelegramHtml(args.text as string), parse_mode: "HTML" }),
  },
  {
    name: "tg_rich_message",
    description: "Send a real rich-formatted Telegram message (HTML: tables, expandable blockquotes, etc).",
    parameters: { type: "object", properties: { html: { type: "string" } }, required: ["html"] },
    execute: async (args, ctx) => ctx.client.sendRichMessage({ chat_id: ctx.chatId, rich_message: { html: args.html as string } }),
  },
  {
    name: "tg_edit_message",
    description: "Edit a real, previously-sent Telegram message's text.",
    parameters: { type: "object", properties: { messageId: { type: "number" }, text: { type: "string" } }, required: ["messageId", "text"] },
    execute: async (args, ctx) => ctx.client.editMessageText({ chat_id: ctx.chatId, message_id: args.messageId as number, text: args.text as string }),
  },
  {
    name: "tg_send_file",
    description: "Send a real document/file to the user.",
    parameters: { type: "object", properties: { fileIdOrUrl: { type: "string" }, caption: { type: "string" } }, required: ["fileIdOrUrl"] },
    execute: async (args, ctx) => ctx.client.sendDocument({ chat_id: ctx.chatId, document: args.fileIdOrUrl as string, caption: args.caption as string | undefined }),
  },
  {
    name: "tg_send_poll",
    description: "Send a real Telegram poll.",
    parameters: { type: "object", properties: { question: { type: "string" }, options: { type: "array", items: { type: "string" } } }, required: ["question", "options"] },
    execute: async (args, ctx) => ctx.client.sendPoll({ chat_id: ctx.chatId, question: args.question as string, options: args.options as string[] }),
  },
  {
    name: "pin_message",
    description: "Pin a real message in the chat.",
    parameters: { type: "object", properties: { messageId: { type: "number" } }, required: ["messageId"] },
    execute: async (args, ctx) => ctx.client.pinChatMessage({ chat_id: ctx.chatId, message_id: args.messageId as number }),
  },
  {
    name: "unpin_message",
    description: "Unpin a real message in the chat (or the most recent pin if no messageId given).",
    parameters: { type: "object", properties: { messageId: { type: "number" } } },
    execute: async (args, ctx) => ctx.client.unpinChatMessage({ chat_id: ctx.chatId, message_id: args.messageId as number | undefined }),
  },
  {
    name: "tg_chat_action",
    description: "Show a real typing/uploading indicator.",
    parameters: { type: "object", properties: { action: { type: "string", enum: ["typing", "upload_document", "upload_photo"] } }, required: ["action"] },
    execute: async (args, ctx) => ctx.client.sendChatAction({ chat_id: ctx.chatId, action: args.action as "typing" | "upload_document" | "upload_photo" }),
  },
  {
    name: "set_bot_profile",
    description: "Update your real bot display name/description/short description.",
    parameters: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, shortDescription: { type: "string" } } },
    execute: async (args, ctx) => ({ updated: await updateBotDisplayInfo(ctx.client, { name: args.name as string | undefined, description: args.description as string | undefined, shortDescription: args.shortDescription as string | undefined }) }),
  },
  {
    name: "edit_bot_menu",
    description: "Register/refresh your real default command menu.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => {
      await registerDefaultCommandMenu(ctx.client);
      return { ok: true };
    },
  },
  {
    name: "telegram_health",
    description: "Real getMe() call -- confirms the bot token is genuinely valid and reachable.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => ctx.client.getMe(),
  },
  {
    name: "deliver_ea",
    description: "Personalize and send the real Dave EA .mq5 file to the user, with their own real webhook URL/token pre-filled.",
    parameters: { type: "object", properties: { userId: { type: "string" }, publicBaseUrl: { type: "string" } }, required: ["userId", "publicBaseUrl"] },
    execute: async (args, ctx) => {
      const { filename, content, webhookUrl, token } = personalizeEaFile(args.userId as string, args.publicBaseUrl as string);
      const caption = `Your personalized EA -- webhook URL and token are already filled in.\n\nWebhook: ${webhookUrl}\nToken: ${token}\n\nDrop it in MQL5/Experts/Dave/, compile with F7, attach to a chart.`;
      await ctx.client.sendDocument({ chat_id: ctx.chatId, document: { buffer: Buffer.from(content, "utf8"), filename }, caption });
      return { webhookUrl, token };
    },
  },
  {
    name: "pair_user",
    description: "Get (or create) the real Dave-to-user push webhook for this user.",
    parameters: { type: "object", properties: { userId: { type: "string" } }, required: ["userId"] },
    execute: async (args) => getOrCreateUserWebhook(args.userId as string),
  },
];
