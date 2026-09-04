import type { TelegramClient } from "@dave/telegram";
import { writeTradeJournalEntry, type TradeJournalInput } from "@dave/workers";

/**
 * Step 21.2: a trade-opened notification includes the trade AND the
 * reasoning TOGETHER, in one message -- not a bare "opened EURUSD buy"
 * ping with reasoning left for the user to dig up elsewhere. Reuses
 * Step 12's real narrative formatter (`writeTradeJournalEntry`)
 * directly rather than building a second, differently-worded formatter
 * for what's the same real content.
 */

export function formatTradeOpenedNotification(input: TradeJournalInput): string {
  return writeTradeJournalEntry(input);
}

export async function sendTradeOpenedNotification(client: TelegramClient, chatId: number | string, input: TradeJournalInput): Promise<{ message_id: number }> {
  const text = formatTradeOpenedNotification(input);
  return client.sendMessage({ chat_id: chatId, text });
}
