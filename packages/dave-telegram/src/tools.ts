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

// Second explicit reversal (the trader, live, after confirming the model-callable version simply
// never got called reliably: "if they is a way you can hardcode this so instead of the bot
// calling it it's already hardcoded"). Back to a single, automatic mechanism -- no model
// tool-calls involved at all this time, closing the exact same "the model has to remember to
// call it" gap that made image generation and other discovery-gated tools invisible in practice.
// tg_thinking/tg_thinking_update/tg_finalize are REMOVED again (matching 1b21a73's original fix),
// and telegram-bot-server.ts's runAgentTurn now drives `withThinkingIndicator` automatically,
// deriving live progress text from real AgentStep tool-call events -- zero AI decision in whether
// or when it shows, same "9.1" design thinking-indicator.ts's own withThinkingIndicator doc
// already describes. `activeIndicators` stays (renamed intent, same map) so the automatic
// wrapper can register itself here too -- sequential-thinking's onSequentialThinkingProgress hook
// (autonomous-tick.ts) already reads through `getActiveIndicator`, no change needed on that side.
const activeIndicators = new Map<number, ThinkingIndicator>();

/** Real safety net (telegram-bot-server.ts's runAgentTurn calls this on every turn's exit path,
 *  success/abort/error alike): if the automatic wrapper's indicator somehow never got finalized
 *  (an exception mid-turn, etc), this is how the caller finds it to clean it up rather than
 *  leaving a "thinking..." message stuck in the chat forever. */
export function getActiveIndicator(chatId: number): ThinkingIndicator | undefined {
  return activeIndicators.get(chatId);
}

/** Registers the automatic wrapper's own indicator so other real code paths (sequential-thinking's
 *  progress hook) can find and update the SAME instance via getActiveIndicator, rather than each
 *  turn's indicator being invisible outside telegram-bot-server.ts. */
export function setActiveIndicator(chatId: number, indicator: ThinkingIndicator): void {
  activeIndicators.set(chatId, indicator);
}

/** Clears the tracked indicator for a chat without touching Telegram -- call after the caller has
 *  itself finalized/cleaned up the real message (or decided there's nothing worth sending). */
export function clearActiveIndicator(chatId: number): void {
  activeIndicators.delete(chatId);
}

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
    name: "tg_send_photo",
    description:
      "Send a real image to the user as an inline Telegram photo (not a generic document/file). " +
      "Use this to hand off the result of generate_image (Lovable MCP) -- pass its returned `url` straight through here so the user actually sees the picture, " +
      "instead of just a text link. There is no automatic forwarding: you must call this yourself after generate_image returns.",
    parameters: { type: "object", properties: { fileIdOrUrl: { type: "string" }, caption: { type: "string" } }, required: ["fileIdOrUrl"] },
    execute: async (args, ctx) => ctx.client.sendPhoto({ chat_id: ctx.chatId, photo: args.fileIdOrUrl as string, caption: args.caption as string | undefined }),
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
