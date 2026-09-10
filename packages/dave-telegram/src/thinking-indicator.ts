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
  // Real bug fixed (item 6, user: "the thinking-draft streaming indicator isn't visibly
  // happening in real use"). sendRichMessageDraft is a real, documented Bot API method, but it's
  // genuinely very new (added within weeks of this fix, per the Bot API changelog) -- real client
  // support for rendering a streamed draft may not be universally rolled out yet, which would
  // explain updates genuinely never appearing on-screen even though the calls themselves succeed.
  // Fixed with a guaranteed-visible fallback that doesn't depend on a brand-new feature: a real,
  // persisted message via the decades-stable sendMessage/editMessageText pair, edited in place as
  // updates come in (throttled so rapid tool calls don't hit Telegram's real edit rate limit),
  // deleted again once finalize() sends the real final answer. The draft call stays too (harmless,
  // free upgrade on clients that DO support it) -- this is belt-and-suspenders, not a replacement.
  private progressMessageId: number | undefined;
  private lastEditAt = 0;
  private static readonly EDIT_THROTTLE_MS = 1200;

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
   *
   * Item 13 real bug fixed (user: "the bot starts showing 'typing,' but then stalls or times
   * out right before actually sending"): every real caller invokes this as `void
   * indicator.update(...)` -- fire-and-forget, since a mid-task draft update must never block
   * the real work. But this method had NO error handling at all: a genuine transient failure
   * (a real Telegram rate limit, a draft that already expired, a network blip) threw INSIDE a
   * promise nobody was awaiting or catching -- a real unhandled promise rejection, which
   * Node's default behavior (unhandledRejection -> throw) turns into an uncaught exception that
   * CRASHES THE WHOLE PROCESS. That exactly matches the reported symptom: typing shows (from
   * start()), then the process dies mid-task on the next draft update, so finalize() never runs
   * and nothing further is ever sent -- not a hang, a real crash. Best-effort now, matching the
   * same swallow-and-continue pattern start() already uses: a failed draft update is cosmetic
   * and must never take down the real task.
   */
  async update(action: ActionType, text: string): Promise<void> {
    const rendered = iconize(action, text);
    this.updates.push({ action, text });
    await this.client
      .sendRichMessageDraft({
        chat_id: this.chatId,
        draft_id: this.draftId,
        rich_message: { html: rendered },
      })
      .catch(() => {});
    await this.updateGuaranteedProgressMessage(rendered);
  }

  /** The guaranteed-visible fallback -- see the class-level comment. Best-effort: a failure here
   *  must never block the real task, same as the draft call above. */
  private async updateGuaranteedProgressMessage(rendered: string): Promise<void> {
    if (this.progressMessageId === undefined) {
      try {
        const sent = await this.client.sendMessage({ chat_id: this.chatId, text: rendered });
        this.progressMessageId = sent.message_id;
        this.lastEditAt = Date.now();
      } catch {
        // best-effort -- the chat action + draft above are still live even if this fails
      }
      return;
    }
    const now = Date.now();
    if (now - this.lastEditAt < ThinkingIndicator.EDIT_THROTTLE_MS) return; // throttled -- avoid a real Telegram edit rate limit on rapid tool calls
    this.lastEditAt = now;
    await this.client.editMessageText({ chat_id: this.chatId, message_id: this.progressMessageId, text: rendered }).catch(() => {});
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
    if (this.progressMessageId !== undefined) {
      await this.client.deleteMessage({ chat_id: this.chatId, message_id: this.progressMessageId }).catch(() => {});
      this.progressMessageId = undefined;
    }
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
