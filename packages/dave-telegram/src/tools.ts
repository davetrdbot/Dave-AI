import type { TelegramClient } from "./client.js";
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

// Real bug fixed (user, live, AGAIN after the 5ebcf25 race fix: "the tool called it's still
// send as message"). tg_thinking/tg_thinking_update/tg_finalize used to be registered here as
// real agent-CALLABLE tools -- but every single chat turn is ALREADY wrapped, automatically and
// with zero AI decision involved, in its own `ThinkingIndicator` by
// `withThinkingIndicator`/`runAgentTurn` in telegram-bot-server.ts (see thinking-indicator.ts's
// own class doc, 9.1: "the caller doesn't ask whether to show the indicator, it's always shown
// for the duration of `task`"), which already edits ONE progress message in place per real tool
// step via `onStep` and cleanly replaces it with the real final answer on completion.
//
// Exposing tg_thinking as a tool the MODEL could also decide to call created a SECOND, totally
// independent `ThinkingIndicator` instance (its own `progressMessageId`, never the automatic
// wrapper's) any time the model chose to invoke it -- which its own tool description actively
// encouraged ("Start showing what you're ACTUALLY doing"). That second indicator's first
// `update()` has no existing message to edit, so it genuinely sends a brand-new message --
// exactly "the tool called it's still send as message". Worse: nothing forces the model to also
// call the matching `tg_finalize` (a plain final-text reply is a fully valid turn ending, and the
// automatic wrapper already sends the real final answer on its own), so that second progress
// message is frequently orphaned in the chat forever, never edited or deleted.
// Removed entirely -- the automatic per-turn indicator already provides 100% of this
// functionality without ever risking a second, uncoordinated message.
export const TELEGRAM_TOOLS: TelegramToolDefinition[] = [
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
