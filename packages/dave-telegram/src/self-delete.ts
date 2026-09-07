import type { TelegramClient, SendMessageParams } from "./client.js";

/**
 * Real gap fixed (user: "any messages... that's not useful should be deleted after sending...
 * because it just filling the place up" -- citing "✅ Deleted X key", "Adding key(s)... Line 1:
 * OK", "✅ Provider switched to X", "✅ SL set to Auto"/"TP set to Auto"/"LOT set to Auto" as
 * examples): low-value, transient confirmation toasts now genuinely self-delete a few seconds
 * after sending, via the real Bot API deleteMessage method -- not left to pile up in the chat
 * forever. Deliberately NOT applied to anything the user might want to reference later (trade
 * notifications, approval records, errors, the full-reset confirmation, etc.) -- only the
 * "yep, that setting changed" class of message.
 */
export const SELF_DELETE_DELAY_MS = 10_000;

/** Fire-and-forget: schedules a real deleteMessage call after `delayMs`. Failure (already
 * deleted, message too old, chat gone) is swallowed -- this is best-effort tidiness, never
 * something that should surface as an error to the user. */
export function scheduleSelfDelete(client: TelegramClient, chatId: number | string, messageId: number, delayMs: number = SELF_DELETE_DELAY_MS): void {
  const timer = setTimeout(() => {
    void client.deleteMessage({ chat_id: chatId, message_id: messageId }).catch(() => undefined);
  }, delayMs);
  // Real gap avoided: an un-unref'd timer keeps the event loop (and, in a test, the whole
  // process) alive until it fires -- a background tidy-up task like this must never be the
  // reason a process/test hangs an extra 10s waiting on it.
  timer.unref?.();
}

/** Sends a message exactly like client.sendMessage(), then schedules its own real deletion. */
export async function sendSelfDeletingMessage(client: TelegramClient, params: SendMessageParams, delayMs: number = SELF_DELETE_DELAY_MS): Promise<{ message_id: number }> {
  const result = await client.sendMessage(params);
  scheduleSelfDelete(client, params.chat_id, result.message_id, delayMs);
  return result;
}
