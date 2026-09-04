/**
 * Step 8: Telegram Bot Core. Raw HTTPS calls to api.telegram.org --
 * deliberately not wrapped in a third-party bot-framework library, since
 * Step 1.6/8's research found the API has moved past most wrapper
 * libraries' coverage (sendRichMessageDraft, ReplyParameters.quote,
 * BotCommandScopeChatMember). A thin real client keeps Dave exactly on
 * the real, current API surface -- verified against the real docs, not
 * assumed:
 *   - REAL: sendRichMessageDraft, ReplyParameters.quote, setMyCommands,
 *     BotCommandScopeChatMember, setChatMenuButton, setMessageReaction,
 *     pinChatMessage, sendPoll
 *   - NOT REAL (corrected after Step 1.6 flagged them for re-verification):
 *     the <tg-thinking> tag, and any setMyProfilePhoto/removeMyProfilePhoto
 *     method -- neither exists in the real Bot API. See profile.ts.
 *   - NOT REAL: InlineKeyboardButton has no color field -- "colored
 *     buttons" are simulated with emoji, see buttons.ts.
 */

export interface TelegramApiError {
  ok: false;
  error_code: number;
  description: string;
}

export class TelegramError extends Error {
  constructor(public readonly method: string, public readonly errorCode: number, description: string) {
    super(`Telegram ${method} -> ${errorCode}: ${description}`);
    this.name = "TelegramError";
  }
}

export interface ReplyParameters {
  message_id: number;
  chat_id?: number | string;
  quote?: string;
  quote_parse_mode?: "HTML" | "MarkdownV2";
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface SendMessageParams {
  chat_id: number | string;
  text: string;
  parse_mode?: "HTML" | "MarkdownV2";
  reply_markup?: InlineKeyboardMarkup;
  reply_parameters?: ReplyParameters;
  disable_web_page_preview?: boolean;
}

export class TelegramClient {
  constructor(private readonly token: string, private readonly baseUrl = "https://api.telegram.org") {}

  private async call<T>(method: string, body?: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    if (!json.ok) {
      const err = json as TelegramApiError;
      throw new TelegramError(method, err.error_code, err.description);
    }
    return json.result as T;
  }

  sendMessage(params: SendMessageParams) {
    return this.call<{ message_id: number }>("sendMessage", params as unknown as Record<string, unknown>);
  }

  /** Real method (confirmed in the Bot API changelog): streams a partial rich message. */
  sendRichMessageDraft(params: { chat_id: number | string; text: string; parse_mode?: "HTML" }) {
    return this.call<{ message_id: number }>("sendRichMessageDraft", params);
  }

  editMessageText(params: { chat_id: number | string; message_id: number; text: string; parse_mode?: "HTML"; reply_markup?: InlineKeyboardMarkup }) {
    return this.call<{ message_id: number }>("editMessageText", params);
  }

  answerCallbackQuery(params: { callback_query_id: string; text?: string; show_alert?: boolean }) {
    return this.call<true>("answerCallbackQuery", params);
  }

  sendDocument(params: { chat_id: number | string; document: string; caption?: string; parse_mode?: "HTML" }) {
    return this.call<{ message_id: number }>("sendDocument", params);
  }

  setMessageReaction(params: { chat_id: number | string; message_id: number; reaction: { type: "emoji"; emoji: string }[] }) {
    return this.call<true>("setMessageReaction", params);
  }

  pinChatMessage(params: { chat_id: number | string; message_id: number; disable_notification?: boolean }) {
    return this.call<true>("pinChatMessage", params);
  }

  sendPoll(params: { chat_id: number | string; question: string; options: string[]; is_anonymous?: boolean }) {
    return this.call<{ message_id: number }>("sendPoll", params);
  }

  sendChatAction(params: { chat_id: number | string; action: "typing" | "upload_document" | "upload_photo" }) {
    return this.call<true>("sendChatAction", params);
  }

  /** BotCommandScope supports per-chat, per-admin, and per-member (real, per-user) scoping. */
  setMyCommands(params: { commands: { command: string; description: string }[]; scope?: Record<string, unknown> }) {
    return this.call<true>("setMyCommands", params);
  }

  getMyCommands(params?: { scope?: Record<string, unknown> }) {
    return this.call<{ command: string; description: string }[]>("getMyCommands", params ?? {});
  }

  setChatMenuButton(params: { chat_id?: number; menu_button?: Record<string, unknown> }) {
    return this.call<true>("setChatMenuButton", params);
  }

  getMe() {
    return this.call<{ id: number; username: string; first_name: string }>("getMe");
  }

  /** Real Bot API methods for the bot's own display info (distinct from the profile PHOTO, which has no API -- see profile.ts). */
  setMyName(params: { name: string }) {
    return this.call<true>("setMyName", params);
  }
  setMyDescription(params: { description: string }) {
    return this.call<true>("setMyDescription", params);
  }
  setMyShortDescription(params: { short_description: string }) {
    return this.call<true>("setMyShortDescription", params);
  }
}
