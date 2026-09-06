import type { TelegramClient } from "./client.js";

/**
 * Step 9: thinking indicator with live action-type icons.
 *
 * Corrected after checking the real sendRichMessageDraft parameter
 * table (an earlier pass assumed it returns a message you then edit
 * with editMessageText -- wrong on both counts):
 *   - sendRichMessageDraft returns `true`, not a message/message_id.
 *   - Updating a draft means calling sendRichMessageDraft AGAIN with the
 *     SAME bot-chosen `draft_id` -- Telegram animates the change. There
 *     is no message to editMessageText; the draft is an ephemeral
 *     ~30-second preview, never a real persisted message.
 *   - Finalizing means calling the real sendRichMessage method (not
 *     editMessageText) with the complete content -- that's the method
 *     that actually returns a real Message and persists it in the chat.
 */

// 9.3: typed enum, not free-form -- an agent can only pick one of these.
export const ACTION_ICONS = {
  code: "</> ",
  database: "\u{1F5C4}\u{FE0F} ", // 🗄️
  api: "\u{1F4E1} ", // 📡
  input: "\u{1F4E5} ", // 📥
  output: "\u{1F4E4} ", // 📤
  memory: "\u{1F9E0} ", // 🧠
  trade: "\u{1F4B9} ", // 💹
  worker: "\u{1F465} ", // 👥
} as const;

export type ActionType = keyof typeof ACTION_ICONS;

export function iconize(action: ActionType, text: string): string {
  return `${ACTION_ICONS[action]}${text}`;
}

// Telegram's real, confirmed limit: 4096 UTF-16 code units per text/rich message. A safety
// margin (not the exact 4096) avoids off-by-one edge cases around multi-byte characters.
const TELEGRAM_MESSAGE_LIMIT = 4000;

/** Splits on paragraph/line boundaries where possible so an HTML tag is far less likely to be
 * cut in half than a naive char-count split would risk. Always returns at least one chunk
 * (an empty string still produces one empty chunk, matching a single sendMessage call). */
export function chunkForTelegram(text: string, limit = TELEGRAM_MESSAGE_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n\n", limit);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt <= 0) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

let draftIdCounter = 1;
/** draft_id must be a non-zero integer the bot chooses -- unique per indicator instance so concurrent tasks don't animate over each other's drafts. */
function nextDraftId(): number {
  return draftIdCounter++;
}

/**
 * 9.1: automatic typing/uploading chat action on every message -- zero
 * AI decision in whether to show it. Infrastructure the message handler
 * always runs, never something the agent loop chooses to call or skip.
 */
export class ThinkingIndicator {
  private readonly draftId = nextDraftId();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private readonly updates: { action: ActionType; text: string }[] = [];

  constructor(
    private readonly client: TelegramClient,
    private readonly chatId: number,
    private readonly chatAction: "typing" | "upload_document" | "upload_photo" = "typing"
  ) {}

  getUpdates(): readonly { action: ActionType; text: string }[] {
    return this.updates;
  }

  /**
   * Best-effort: a failed "typing..." indicator (e.g. a transient
   * Telegram error) must never block the actual task from running, so
   * failures here are swallowed rather than thrown.
   */
  async start(): Promise<void> {
    await this.client.sendChatAction({ chat_id: this.chatId, action: this.chatAction }).catch(() => {});
    this.heartbeat = setInterval(() => {
      void this.client.sendChatAction({ chat_id: this.chatId, action: this.chatAction }).catch(() => {});
    }, 4000);
  }

  /**
   * 9.2/9.3: the tool the agent calls to update the visible thinking
   * text live, icon-prefixed by typed action. Every call reuses the same
   * draft_id so Telegram animates the change on the same ephemeral
   * draft, per the real sendRichMessageDraft contract.
   */
  async update(action: ActionType, text: string): Promise<void> {
    const rendered = iconize(action, text);
    this.updates.push({ action, text });
    await this.client.sendRichMessageDraft({
      chat_id: this.chatId,
      draft_id: this.draftId,
      rich_message: { html: rendered },
    });
  }

  /**
   * 9.4: finalizes cleanly into a real, persisted message -- via the
   * real sendRichMessage method (not editMessageText: the draft was
   * never a real message to edit).
   *
   * Real bug fixed: Telegram's real, hard 4096-character-per-message limit
   * was never respected here -- a genuinely long final answer (a full trade
   * journal recap, a detailed reasoning explanation) would have made this
   * call fail outright with a real Telegram 400 ("message is too long"),
   * not just "arrive as one giant message." Chunked, sent as multiple real
   * sequential messages instead -- as close to "streams progressively" as
   * this architecture (which gets a complete, non-streamed answer back
   * from the provider) can honestly get without providers streaming
   * partial completions themselves.
   */
  async finalize(finalText: string): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    const chunks = chunkForTelegram(finalText);
    for (const chunk of chunks) {
      await this.client.sendRichMessage({ chat_id: this.chatId, rich_message: { html: chunk } });
    }
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
  }
}

/**
 * The wrapper every message handler actually calls -- this is what
 * makes 9.1 "zero AI decision": the caller doesn't ask whether to show
 * the indicator, it's always shown for the duration of `task`.
 */
export async function withThinkingIndicator<T>(
  client: TelegramClient,
  chatId: number,
  task: (indicator: ThinkingIndicator) => Promise<{ result: T; finalText: string }>
): Promise<T> {
  const indicator = new ThinkingIndicator(client, chatId);
  await indicator.start();
  try {
    const { result, finalText } = await task(indicator);
    await indicator.finalize(finalText);
    return result;
  } finally {
    indicator.stop();
  }
}
