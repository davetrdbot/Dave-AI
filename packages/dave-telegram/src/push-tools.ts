import type { TelegramClient } from "./client.js";
import { markdownToTelegramHtml } from "./rich-format.js";

/**
 * Update 14 (mid-session gap: "push to user"): a real tool letting
 * Dave PROACTIVELY message the user -- a trade alert, an urgent
 * heads-up, a worker's report -- distinct from replying to something
 * the user just said. Same real `sendMessage` call as any reply; the
 * distinction is that this is exposed as something the agent decides
 * to call on its own initiative, not gated behind an incoming message.
 */
export interface PushToolContext {
  client: TelegramClient;
  chatId: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: PushToolContext) => Promise<unknown>;
}

export const PUSH_TOOLS: ToolDefinition[] = [
  {
    name: "push_message_to_user",
    description: "Proactively send the user a real Telegram message right now -- use this when you have something to tell them that isn't a reply to something they just asked (a trade alert, an urgent heads-up, a subagent's report).",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    // Real gap fixed (item 2, "raw HTML tags visible to the user"): this is a CORE tool the model
    // calls directly and frequently -- its text used to go straight to sendMessage with no
    // parse_mode/conversion at all, so any markdown OR any genuine HTML tag the model wrote would
    // have leaked to the user completely raw.
    execute: async (args, ctx) => ctx.client.sendMessage({ chat_id: ctx.chatId, text: markdownToTelegramHtml(args.text as string), parse_mode: "HTML" }),
  },
];
