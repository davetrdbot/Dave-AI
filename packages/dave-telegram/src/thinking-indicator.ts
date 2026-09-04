import type { TelegramClient } from "./client.js";

/**
 * Step 9: thinking indicator with live action-type icons.
 *
 * 9.3: typed enum, not free-form text -- an agent can only pick one of
 * these action types, never invent its own icon/prefix.
 */
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

/**
 * 9.1: automatic typing/uploading chat action on every message -- zero
 * AI decision in whether to show it. This is infrastructure the message
 * handler always runs, never something the agent loop chooses to call
 * or skip. Telegram's chat action only lasts ~5s, so it's kept alive on
 * a heartbeat for the duration of the task.
 */
export class ThinkingIndicator {
  private messageId: number | undefined;
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
   * Called automatically the moment a message handler starts working --
   * not an agent decision. Best-effort: a failed "typing..." indicator
   * (e.g. a transient Telegram error) must never block the actual task
   * from running, so failures here are swallowed rather than thrown.
   */
  async start(): Promise<void> {
    await this.client.sendChatAction({ chat_id: this.chatId, action: this.chatAction }).catch(() => {});
    this.heartbeat = setInterval(() => {
      void this.client.sendChatAction({ chat_id: this.chatId, action: this.chatAction }).catch(() => {});
    }, 4000);
  }

  /** 9.2/9.3: the tool the agent calls to update the visible thinking text live, icon-prefixed by typed action. */
  async update(action: ActionType, text: string): Promise<void> {
    const rendered = iconize(action, text);
    this.updates.push({ action, text });
    if (this.messageId === undefined) {
      const result = await this.client.sendRichMessageDraft({ chat_id: this.chatId, text: rendered, parse_mode: "HTML" });
      this.messageId = result.message_id;
    } else {
      await this.client.editMessageText({ chat_id: this.chatId, message_id: this.messageId, text: rendered, parse_mode: "HTML" });
    }
  }

  /** 9.4: finalizes cleanly into a real message when done -- no more draft/thinking styling. */
  async finalize(finalText: string): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.messageId === undefined) {
      await this.client.sendMessage({ chat_id: this.chatId, text: finalText, parse_mode: "HTML" });
    } else {
      await this.client.editMessageText({ chat_id: this.chatId, message_id: this.messageId, text: finalText, parse_mode: "HTML" });
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
