import type { TelegramClient, TelegramChatAction, RichMessageMedia } from "./client.js";
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
    description:
      "Send a plain real Telegram message. Optional linkPreview controls the URL preview card: 'off' hides it, 'large'/'small' sizes it, 'above' puts it over the text. Leave unset for the default.",
    parameters: {
      type: "object",
      required: ["text"],
      properties: { text: { type: "string" }, linkPreview: { type: "string", enum: ["off", "small", "large", "above"] } },
    },
    execute: async (args, ctx) => {
      const lp = args.linkPreview as "off" | "small" | "large" | "above" | undefined;
      const link_preview_options = lp
        ? {
            is_disabled: lp === "off" || undefined,
            prefer_small_media: lp === "small" || undefined,
            prefer_large_media: lp === "large" || undefined,
            show_above_text: lp === "above" || undefined,
          }
        : undefined;
      return ctx.client.sendMessage({ chat_id: ctx.chatId, text: markdownToTelegramHtml(args.text as string), parse_mode: "HTML", link_preview_options });
    },
  },
  {
    name: "tg_rich_message",
    description:
      "Send a real rich-formatted Telegram message (Bot API rich messages -- up to ~32k chars, tables, headings, expandable blockquotes, and more than plain sendMessage can do). " +
      "Write HTML. To embed a chart/image/video INLINE in the message, put a tg://photo?id=<id> (or tg://video?id=, tg://document?id=, tg://audio?id=) link where it should appear and pass that media in the `media` array with the same id. " +
      "For a row of tappable buttons use the <tg-button-row> tag in the HTML.",
    parameters: {
      type: "object",
      required: ["html"],
      properties: {
        html: { type: "string" },
        media: {
          type: "array",
          description: "media referenced in the html via tg://<kind>?id=<id> links",
          items: {
            type: "object",
            required: ["id", "type", "url"],
            properties: {
              id: { type: "string", description: "1-64 chars [A-Za-z0-9_-]; must match the tg://...?id= link in the html" },
              type: { type: "string", enum: ["photo", "video", "animation", "audio", "document", "voice_note"] },
              url: { type: "string", description: "a URL or Telegram file_id for the media" },
              caption: { type: "string" },
            },
          },
        },
      },
    },
    execute: async (args, ctx) => {
      const media = (args.media as { id: string; type: string; url: string; caption?: string }[] | undefined)?.map((m) => ({
        id: m.id,
        media: { type: m.type as RichMessageMedia["media"]["type"], media: m.url, caption: m.caption },
      }));
      return ctx.client.sendRichMessage({ chat_id: ctx.chatId, rich_message: { html: args.html as string, media } });
    },
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
    description:
      "Show a real Telegram 'loading' indicator to the user -- the little 'Dave is typing…' / 'sending a photo…' status. Auto-clears after a few seconds or when your next message lands; send it again for a longer wait. Use the one that matches what you're about to do.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "typing",
            "upload_photo",
            "record_video",
            "upload_video",
            "record_voice",
            "upload_voice",
            "upload_document",
            "choose_sticker",
            "find_location",
            "record_video_note",
            "upload_video_note",
          ],
        },
      },
      required: ["action"],
    },
    execute: async (args, ctx) => ctx.client.sendChatAction({ chat_id: ctx.chatId, action: args.action as TelegramChatAction }),
  },
  {
    // Real Bot API setMessageReaction. The client method existed; nothing exposed it to Dave.
    name: "react_to_message",
    description:
      "React to a message with a single emoji (👍 ❤️ 🔥 🎉 😁 🤔 👏 🙏 💯 and the rest Telegram allows), the way a person taps a reaction. Pass the message id and one emoji; pass an empty emoji to clear your reaction. Lighter than a whole reply -- use it to acknowledge without adding a message.",
    parameters: {
      type: "object",
      properties: { messageId: { type: "number" }, emoji: { type: "string", description: "one emoji, or empty to clear the reaction" } },
      required: ["messageId"],
    },
    execute: async (args, ctx) =>
      ctx.client.setMessageReaction({
        chat_id: ctx.chatId,
        message_id: args.messageId as number,
        reaction: args.emoji ? [{ type: "emoji", emoji: args.emoji as string }] : [],
      }),
  },
  {
    // Real Bot API deleteMessage. Used internally for self-cleaning; now Dave-callable.
    name: "delete_message",
    description:
      "Delete a message this bot sent (by its message id). Use it to clean up a message that's now wrong or obsolete -- e.g. a stale trade alert after the position closed. Only works on the bot's own messages (and, in a group where it's admin, others').",
    parameters: { type: "object", properties: { messageId: { type: "number" } }, required: ["messageId"] },
    execute: async (args, ctx) => ctx.client.deleteMessage({ chat_id: ctx.chatId, message_id: args.messageId as number }),
  },
  {
    // Real Bot API stopPoll. The client method existed (used by the feedback loop); no Dave tool.
    name: "stop_poll",
    description: "Close a poll you sent (by its message id) so it stops taking votes, and get back the final tallies. There is no way to edit a live poll's options -- close and send a new one.",
    parameters: { type: "object", properties: { messageId: { type: "number" } }, required: ["messageId"] },
    execute: async (args, ctx) => ctx.client.stopPoll({ chat_id: ctx.chatId, message_id: args.messageId as number }),
  },
  {
    // Real Bot API sendRichMessageDraft (Bot API 10.1). Streams a rich message block-by-block under
    // a stable draft_id so a long/generated reply renders as it's built, instead of many separate
    // sendMessage calls (which burn the rate limit). The client method existed; no Dave tool.
    name: "send_rich_draft",
    description:
      "Stream a rich message as a live-updating DRAFT rather than sending it all at once -- ideal for a long report or a reply you're building up. Call it repeatedly with the SAME draftId to progressively replace the draft's content (HTML: tables, headings, expandable quotes, up to ~32k chars). Finalise by sending the finished HTML through tg_rich_message. Use a fresh draftId per message; keepOnStop leaves the last draft visible if you stop early.",
    parameters: {
      type: "object",
      properties: {
        draftId: { type: "number", description: "a stable id for THIS draft; reuse it across updates of the same message" },
        html: { type: "string", description: "the rich HTML content so far (replaces the draft's current content)" },
        canStop: { type: "boolean", description: "let the user stop the stream" },
        keepOnStop: { type: "boolean", description: "keep the last draft content visible if stopped" },
      },
      required: ["draftId", "html"],
    },
    execute: async (args, ctx) =>
      ctx.client.sendRichMessageDraft({
        chat_id: ctx.chatId,
        draft_id: args.draftId as number,
        rich_message: { html: args.html as string },
        can_stop: args.canStop as boolean | undefined,
        keep_on_stop: args.keepOnStop as boolean | undefined,
      }),
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
