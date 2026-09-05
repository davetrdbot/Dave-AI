import type { DaveDatabase } from "@dave/db";
import { registerWebhookTrigger, type AutomationWebhook } from "@dave/db";
import type { TelegramClient } from "@dave/telegram";

/**
 * Step 18.5: feedback poll results actually referenced during
 * reflection. Real gap found while building this: nothing in the repo
 * received a Telegram `poll_answer` update -- `sendPoll` (Step 8) only
 * sends. Rather than build a second webhook server, this reuses Step
 * 16's real generic `/hooks/automation/<token>` mechanism: a poll's
 * answer webhook IS an external event, exactly what that trigger type
 * is for. When Dave's real Telegram update relay (Step 22 territory)
 * forwards a `poll_answer` update to this URL, `recordPollResult` is
 * what actually persists it -- this module doesn't invent a parallel
 * inbound channel.
 */

export interface FeedbackPollResult {
  id: string;
  question: string;
  options: string[];
  selectedOptionIndex: number;
  ts: number;
}

interface PollResultRow {
  id: string;
  question: string;
  options_json: string;
  selected_option_index: number;
  created_at: number;
}

const TABLE = "feedback_poll_results";

function ensureTable(db: DaveDatabase): void {
  db.createTable(TABLE, [
    { name: "question", type: "TEXT" },
    { name: "options_json", type: "TEXT" },
    { name: "selected_option_index", type: "INTEGER" },
  ]);
}

export function recordPollResult(db: DaveDatabase, ownerUserId: string, question: string, options: string[], selectedOptionIndex: number): string {
  ensureTable(db);
  return db.insert(TABLE, ownerUserId, { question, options_json: JSON.stringify(options), selected_option_index: selectedOptionIndex });
}

export function getPollResultsSince(db: DaveDatabase, ownerUserId: string, sinceTs: number): FeedbackPollResult[] {
  ensureTable(db);
  const rows = db.query(TABLE, ownerUserId, {}) as unknown as PollResultRow[];
  return rows
    .filter((r) => r.created_at >= sinceTs)
    .map((r) => ({ id: r.id, question: r.question, options: JSON.parse(r.options_json), selectedOptionIndex: r.selected_option_index, ts: r.created_at }));
}

/**
 * Sends a real poll AND registers a real webhook to receive its answer
 * -- returns the sent message id, the poll's own id (what a real
 * `poll_answer` update correlates against, NOT message_id), and the
 * webhook the relay forwards to for this specific poll.
 *
 * Two real gaps closed here after tracing the actual Bot API contract:
 * 1. `is_anonymous: false` is required -- Telegram never sends
 *    `poll_answer` updates for an anonymous poll (the default), so an
 *    anonymous poll's answer would silently never arrive.
 * 2. The webhook token IS the poll's own real id (`sent.poll.id`), not a
 *    fresh random token -- so the Telegram update relay (which only has
 *    `poll_id` off the real `poll_answer` update, never a message_id) can
 *    find this exact registration with no separate lookup table needed.
 */
export async function sendFeedbackPoll(
  client: TelegramClient,
  db: DaveDatabase,
  ownerUserId: string,
  chatId: number | string,
  question: string,
  options: string[]
): Promise<{ messageId: number; pollId: string; webhook: AutomationWebhook }> {
  ensureTable(db);
  const sent = await client.sendPoll({ chat_id: chatId, question, options, is_anonymous: false });
  const pollId = sent.poll.id;
  const webhook = registerWebhookTrigger(`poll-${sent.message_id}`, (payload) => {
    const { selectedOptionIndex } = payload as { selectedOptionIndex: number };
    recordPollResult(db, ownerUserId, question, options, selectedOptionIndex);
  }, pollId);
  return { messageId: sent.message_id, pollId, webhook };
}
