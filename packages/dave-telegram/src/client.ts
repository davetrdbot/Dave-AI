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
  /** Real field, confirmed against the real docs -- Telegram DOES natively support colored buttons. */
  style?: "danger" | "success" | "primary";
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

/**
 * Real InputRichMessage shape, verified against the docs: exactly one of
 * html/markdown/blocks is used. We only ever need `html` -- the full
 * block-based format (InputRichBlock*, tables, thinking blocks, etc.) is
 * real but out of scope for what Dave needs from rich messages today.
 */
/** The full, real Bot API set of sendChatAction values (the "loading" indicators) -- confirmed
 *  against the live docs 2026-09-19. Previously only 3 of these 11 were typed/reachable. */
export type TelegramChatAction =
  | "typing"
  | "upload_photo"
  | "record_video"
  | "upload_video"
  | "record_voice"
  | "upload_voice"
  | "upload_document"
  | "choose_sticker"
  | "find_location"
  | "record_video_note"
  | "upload_video_note";

/** One media element embedded in a rich message (Bot API 10.2). The `id` (1-64 chars, A-Za-z0-9_-)
 *  is what the html/markdown references via a tg://photo?id=<id> / video / document / audio link. */
export interface RichMessageMedia {
  id: string;
  media: { type: "photo" | "video" | "animation" | "audio" | "document" | "voice_note"; media: string; caption?: string };
}

export interface RichMessage {
  /** Exactly one of html / markdown is used here (the block-array form isn't modelled). */
  html?: string;
  markdown?: string;
  /** Bot API 10.2: media referenced inside html/markdown via tg://photo?id= etc. */
  media?: RichMessageMedia[];
  is_rtl?: boolean;
  skip_entity_detection?: boolean;
}

/** Real, minimal shape of a Telegram Update -- just the fields this build actually reads. */
/** Real inbound-file shapes (Step 15, both directions): what Telegram's own Bot API sends on `message.voice`/`.photo`/`.document`. */
export interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; username?: string; first_name?: string; is_bot?: boolean };
  text?: string;
  caption?: string;
  date: number;
  /** A voice note (`.ogg`/OPUS) -- Telegram always sends exactly one of these, never an array. */
  voice?: TelegramVoice;
  /** A photo -- Telegram sends every generated resolution; the LAST entry is the largest (Bot API's own documented ordering). */
  photo?: TelegramPhotoSize[];
  /** A generic file upload (PDF, .mq5, any non-media file, or a "compressed: off" photo). */
  document?: TelegramDocument;
}

export interface TelegramCallbackQuery {
  id: string;
  from: { id: number };
  message?: TelegramMessage;
  data?: string;
}

/** Real Bot API shape for an incoming poll answer -- `poll_id` is what correlates back to the poll's own id (NOT the message_id the poll was sent as), `option_ids` is which option(s) the user picked. */
export interface TelegramPollAnswer {
  poll_id: string;
  user?: { id: number; username?: string; first_name?: string };
  option_ids: number[];
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  poll_answer?: TelegramPollAnswer;
}

export interface SendMessageParams {
  chat_id: number | string;
  text: string;
  parse_mode?: "HTML" | "MarkdownV2";
  reply_markup?: InlineKeyboardMarkup;
  reply_parameters?: ReplyParameters;
  disable_web_page_preview?: boolean;
  /** Real Bot API LinkPreviewOptions -- finer control than the legacy disable_web_page_preview. */
  link_preview_options?: {
    is_disabled?: boolean;
    url?: string;
    prefer_small_media?: boolean;
    prefer_large_media?: boolean;
    show_above_text?: boolean;
  };
}

/**
 * Step 15: a local file about to be uploaded (raw bytes -- as opposed to
 * a `file_id`/URL string, which Telegram just resolves server-side).
 */
export interface LocalFile {
  buffer: Buffer;
  filename: string;
}

/** Any of these methods accept either a previously-known file_id/URL (string), or real local bytes to upload. */
export type FileInput = string | LocalFile;

function isLocalFile(input: FileInput): input is LocalFile {
  return typeof input !== "string";
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

  /**
   * Step 15.3: uploading real local bytes requires multipart/form-data --
   * confirmed against the real docs' InputFile definition ("must be
   * posted using multipart/form-data"), not plain JSON like every other
   * call here. `fileField` is the method's own file parameter name
   * (`document`, `photo`, `video`, `voice`, `video_note`, `animation`) --
   * no `attach://` indirection needed for a single-file method (that
   * convention is only for InputMedia-array methods like
   * sendMediaGroup).
   */
  private async callMultipart<T>(method: string, fields: Record<string, unknown>, fileField: string, file: LocalFile): Promise<T> {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      form.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
    form.append(fileField, new Blob([new Uint8Array(file.buffer)]), file.filename);

    const res = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, { method: "POST", body: form });
    const json = await res.json();
    if (!json.ok) {
      const err = json as TelegramApiError;
      throw new TelegramError(method, err.error_code, err.description);
    }
    return json.result as T;
  }

  /** Dispatches to JSON (file_id/URL) or multipart (real local bytes) depending on what was actually given. */
  private sendFile<T>(method: string, fileField: string, fields: Record<string, unknown>, file: FileInput): Promise<T> {
    if (isLocalFile(file)) {
      return this.callMultipart<T>(method, fields, fileField, file);
    }
    return this.call<T>(method, { ...fields, [fileField]: file });
  }

  sendMessage(params: SendMessageParams) {
    return this.call<{ message_id: number }>("sendMessage", params as unknown as Record<string, unknown>);
  }

  /**
   * Real method, verified against the full real parameter table (not
   * assumed from the changelog blurb alone -- an earlier pass here got
   * this wrong). Returns `true`, NOT a message/message_id. `draft_id` is
   * a bot-chosen non-zero integer: calling this again with the SAME
   * draft_id animates an update to the same draft; a different draft_id
   * replaces it without animation. The draft is an ephemeral ~30s
   * preview -- it is never a real message, so there is nothing to
   * editMessageText on. Finalizing requires sendRichMessage() instead.
   */
  sendRichMessageDraft(params: { chat_id: number | string; draft_id: number; rich_message: RichMessage; message_thread_id?: number; can_stop?: boolean; keep_on_stop?: boolean }) {
    return this.call<true>("sendRichMessageDraft", params);
  }

  /** The real "finalize into a persisted message" method for rich content -- NOT editMessageText. Returns a real Message. */
  sendRichMessage(params: { chat_id: number | string; rich_message: RichMessage; message_thread_id?: number; disable_notification?: boolean }) {
    return this.call<{ message_id: number }>("sendRichMessage", params);
  }

  editMessageText(params: { chat_id: number | string; message_id: number; text: string; parse_mode?: "HTML"; reply_markup?: InlineKeyboardMarkup }) {
    return this.call<{ message_id: number }>("editMessageText", params);
  }

  /** Real Bot API method -- deletes a message this bot sent (or, in a group where the bot is
   * admin, any message). Used for self-cleaning up low-value confirmation toasts (self-delete.ts). */
  deleteMessage(params: { chat_id: number | string; message_id: number }) {
    return this.call<true>("deleteMessage", params);
  }

  answerCallbackQuery(params: { callback_query_id: string; text?: string; show_alert?: boolean }) {
    return this.call<true>("answerCallbackQuery", params);
  }

  /**
   * Step 15.3: the FULL range of output types, each a real Bot API
   * method, each accepting either a known file_id/URL or genuine local
   * bytes (multipart) -- verified limits from the real docs:
   *   - sendDocument/sendVideo/sendAnimation/sendVoice: up to 50MB
   *   - sendPhoto: up to 10MB, ratio <=20:1
   *   - sendVideoNote: up to 1 minute, square/round (falls under the 50MB cap)
   * sendVoice specifically requires .ogg/OPUS, .mp3, or .m4a -- anything
   * else is real but won't render as a voice bubble (Telegram treats it
   * as a plain Audio/Document instead of silently rejecting it).
   */
  sendDocument(params: { chat_id: number | string; document: FileInput; caption?: string; parse_mode?: "HTML" }) {
    const { document, ...fields } = params;
    return this.sendFile<{ message_id: number }>("sendDocument", "document", fields, document);
  }

  sendPhoto(params: { chat_id: number | string; photo: FileInput; caption?: string; parse_mode?: "HTML" }) {
    const { photo, ...fields } = params;
    return this.sendFile<{ message_id: number }>("sendPhoto", "photo", fields, photo);
  }

  sendVideo(params: { chat_id: number | string; video: FileInput; caption?: string; parse_mode?: "HTML" }) {
    const { video, ...fields } = params;
    return this.sendFile<{ message_id: number }>("sendVideo", "video", fields, video);
  }

  sendVoice(params: { chat_id: number | string; voice: FileInput; caption?: string; parse_mode?: "HTML"; duration?: number }) {
    const { voice, ...fields } = params;
    return this.sendFile<{ message_id: number }>("sendVoice", "voice", fields, voice);
  }

  sendVideoNote(params: { chat_id: number | string; video_note: FileInput; duration?: number; length?: number }) {
    const { video_note, ...fields } = params;
    return this.sendFile<{ message_id: number }>("sendVideoNote", "video_note", fields, video_note);
  }

  sendAnimation(params: { chat_id: number | string; animation: FileInput; caption?: string; parse_mode?: "HTML" }) {
    const { animation, ...fields } = params;
    return this.sendFile<{ message_id: number }>("sendAnimation", "animation", fields, animation);
  }

  /**
   * Step 15.1: the first half of downloading a user-sent file. Real
   * shape confirmed against the docs' File object: `file_path` is
   * OPTIONAL on the response (absent if Telegram can't resolve it), and
   * the resulting download link is only GUARANTEED valid for at least 1
   * hour -- callers that hold onto a link rather than downloading
   * immediately should treat it as expiring and re-call getFile.
   */
  getFile(params: { file_id: string }) {
    return this.call<{ file_id: string; file_unique_id: string; file_size?: number; file_path?: string }>("getFile", params);
  }

  /** Real download URL format, confirmed against the docs (distinct from the bot<TOKEN> API-call URL shape). */
  getFileDownloadUrl(filePath: string): string {
    return `${this.baseUrl}/file/bot${this.token}/${filePath}`;
  }

  /** getFile + the actual byte fetch, combined -- the real two-step download Telegram requires. */
  async downloadFile(fileId: string): Promise<Buffer> {
    const file = await this.getFile({ file_id: fileId });
    if (!file.file_path) {
      throw new TelegramError("getFile", 400, `file_id ${fileId} has no file_path -- Telegram could not resolve it`);
    }
    const res = await fetch(this.getFileDownloadUrl(file.file_path));
    if (!res.ok) {
      throw new TelegramError("downloadFile", res.status, `download failed for ${file.file_path}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  setMessageReaction(params: { chat_id: number | string; message_id: number; reaction: { type: "emoji"; emoji: string }[] }) {
    return this.call<true>("setMessageReaction", params);
  }

  pinChatMessage(params: { chat_id: number | string; message_id: number; disable_notification?: boolean }) {
    return this.call<true>("pinChatMessage", params);
  }

  unpinChatMessage(params: { chat_id: number | string; message_id?: number }) {
    return this.call<true>("unpinChatMessage", params);
  }

  /** Real Bot API `sendPoll` returns the full sent Message, which includes a `poll` object carrying the poll's OWN id -- distinct from `message_id` -- that's what a real `poll_answer` update correlates back against. */
  sendPoll(params: { chat_id: number | string; question: string; options: string[]; is_anonymous?: boolean }) {
    return this.call<{ message_id: number; poll: { id: string; question: string; options: { text: string; voter_count: number }[] } }>("sendPoll", params);
  }

  /**
   * Real gap fixed (item 7: "Dave can SEND a poll, but cannot edit an existing poll afterward").
   * The real Bot API has no method to change a live poll's options in place -- `stopPoll` (closing
   * it, freezing its final results) is the only real, honest "edit" a poll supports; changing the
   * question/options for real means stopping this one and sending a fresh poll, which
   * `editPoll()` below does explicitly rather than pretending an in-place edit exists.
   */
  stopPoll(params: { chat_id: number | string; message_id: number }) {
    return this.call<{ id: string; question: string; options: { text: string; voter_count: number }[]; is_closed: boolean }>("stopPoll", params);
  }

  sendChatAction(params: { chat_id: number | string; action: TelegramChatAction }) {
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

  /**
   * Real long-polling receive path -- confirmed real Bot API method.
   * `offset` should be the last update_id + 1 you've already processed
   * (Telegram keeps returning old updates otherwise); `timeout` (seconds)
   * makes this a genuine long-poll rather than a busy loop.
   */
  getUpdates(params: { offset?: number; timeout?: number; allowed_updates?: string[] } = {}) {
    return this.call<TelegramUpdate[]>("getUpdates", params);
  }

  /**
   * Real Bot API webhook methods -- the production alternative to
   * getUpdates() long-polling. Telegram POSTs each Update to `url`
   * itself the moment it happens, instead of the bot having to ask.
   * `secret_token` (if set) comes back as the `X-Telegram-Bot-Api-
   * Secret-Token` header on every real webhook POST -- confirmed real
   * mechanism for verifying a request genuinely came from Telegram.
   */
  setWebhook(params: { url: string; secret_token?: string; allowed_updates?: string[]; drop_pending_updates?: boolean }) {
    return this.call<true>("setWebhook", params);
  }

  deleteWebhook(params: { drop_pending_updates?: boolean } = {}) {
    return this.call<true>("deleteWebhook", params);
  }

  getWebhookInfo() {
    return this.call<{ url: string; has_custom_certificate: boolean; pending_update_count: number; last_error_date?: number; last_error_message?: string }>("getWebhookInfo");
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
