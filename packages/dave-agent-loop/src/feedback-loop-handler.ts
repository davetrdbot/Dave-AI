import type { DaveDatabase } from "@dave/db";
import { registerScheduledTrigger, unregisterScheduledTrigger } from "@dave/db";
import type { TelegramClient } from "@dave/telegram";
import type { Worker } from "@dave/workers";
import {
  registerDreamingCron,
  unregisterDreamingCron,
  registerWeeklyExportCron,
  unregisterWeeklyExportCron,
  subscribeTradeCountReflection,
  sendFeedbackPoll,
  type DreamingInput,
  type ReflectionInput,
  type WeeklyExportResult,
} from "@dave/feedback";
import { getPrimaryChatId } from "./primary-chat.js";

/**
 * Real gap fixed (Step 18 re-verification): every one of the 6 real
 * feedback-loop jobs (18.1 dreaming cron, 18.2 trade-count reflection,
 * 18.5 the poll SEND side, 18.6 weekly export) was genuinely real,
 * tested code -- but nothing in production ever called
 * `registerDreamingCron`/`registerWeeklyExportCron`/
 * `subscribeTradeCountReflection`, and nothing ever sent the weekly
 * feedback poll on a schedule. They existed only as functions the
 * step-18 test invoked directly. This wires all of them at startup,
 * exactly the same pattern `wireMorningBrief` already established for
 * Step 21's morning brief (F5).
 */

export interface FeedbackLoopDeps {
  db: DaveDatabase;
  client: TelegramClient;
  ownerUserId: string;
  /** Root directory the weekly dataset export writes under -- defaults to `<cwd>/data`, matching the skip-log/hypotheses JSONL stores' own convention. */
  dataRoot?: string;
}

function composeDreamMessage(input: DreamingInput): string {
  const pending = input.hypotheses.filter((h) => h.verdict === "pending").length;
  const confirmed = input.hypotheses.filter((h) => h.verdict === "confirmed").length;
  const failed = input.hypotheses.filter((h) => h.verdict === "failed").length;
  return [
    "<b>🌙 Weekly Dreaming Reflection</b>",
    `Trades ever: ${input.allTradesEver.length} | Skips ever: ${input.allSkipsEver.length}`,
    `Hypotheses -- confirmed: ${confirmed}, failed: ${failed}, still pending: ${pending}`,
  ].join("\n");
}

function composeReflectionMessage(input: ReflectionInput): string {
  const pollLine =
    input.pollResults.length > 0
      ? input.pollResults.map((p) => `"${p.question}" → ${p.options[p.selectedOptionIndex]}`).join("; ")
      : "no feedback poll answers since last reflection";
  return [
    "<b>🪞 Trade-Count Reflection</b>",
    `${input.trades.length} trades and ${input.skips.length} skips since the last reflection.`,
    `Feedback: ${pollLine}`,
  ].join("\n");
}

function composeExportMessage(result: WeeklyExportResult): string {
  return `<b>🗂️ Weekly dataset export</b>\n${result.tradeCount} trades, ${result.skipCount} skips, ${result.hypothesisCount} hypotheses written to <code>${result.path}</code>`;
}

async function sendToPrimaryChat(deps: FeedbackLoopDeps, text: string, label: string): Promise<void> {
  const chatId = getPrimaryChatId(deps.db, deps.ownerUserId);
  if (chatId === undefined) {
    console.warn(`[feedback-loop] no known chat for ${deps.ownerUserId} yet -- skipping ${label} push (owner has never messaged the bot)`);
    return;
  }
  await deps.client.sendMessage({ chat_id: chatId, text, parse_mode: "HTML" });
}

export const DEFAULT_WEEKLY_POLL_CRON = "0 18 * * 0"; // Sunday 18:00 UTC -- ahead of the dreaming cron's Sunday 03:00 (next week) so an answer has time to land before the reflection that references it
export const DEFAULT_WEEKLY_POLL_QUESTION = "How did this week's trading aggressiveness feel?";
export const DEFAULT_WEEKLY_POLL_OPTIONS = ["Too aggressive", "About right", "Too cautious"];

export interface WiredFeedbackLoop {
  unwire(): void;
}

/** Called once at startup to make all 6 of Step 18's real feedback-loop jobs genuinely fire in this process. */
export function wireFeedbackLoop(deps: FeedbackLoopDeps): WiredFeedbackLoop {
  const exportRoot = deps.dataRoot ?? `${process.cwd()}/data`;

  registerDreamingCron(deps.db, deps.ownerUserId, async (_worker: Worker, input: DreamingInput) => {
    await sendToPrimaryChat(deps, composeDreamMessage(input), "dreaming reflection");
  });

  registerWeeklyExportCron(deps.db, deps.ownerUserId, exportRoot, (result) => {
    // Real bug fixed (bug-hunt pass): the lone unguarded fire-and-forget in this file -- the two
    // sibling crons either side of it correctly await inside async handlers. sendToPrimaryChat
    // awaits a real Telegram call that rejects on a network blip, a 429, or "message is too
    // long", and this fires from inside a node-cron callback with no caller frame to absorb it:
    // an unhandled rejection, which Node turns into a process-killing uncaught exception on a
    // live trading bot, over a weekly export message.
    void sendToPrimaryChat(deps, composeExportMessage(result), "weekly export").catch((err) => {
      console.error(`[feedback-loop] weekly export message failed to send for ${deps.ownerUserId}:`, err);
    });
  });

  const unsubscribeReflection = subscribeTradeCountReflection(deps.db, deps.ownerUserId, async (input: ReflectionInput) => {
    await sendToPrimaryChat(deps, composeReflectionMessage(input), "trade-count reflection");
  });

  const pollTriggerId = `feedback-poll-${deps.ownerUserId}`;
  registerScheduledTrigger(pollTriggerId, DEFAULT_WEEKLY_POLL_CRON, async () => {
    const chatId = getPrimaryChatId(deps.db, deps.ownerUserId);
    if (chatId === undefined) {
      console.warn(`[feedback-loop] no known chat for ${deps.ownerUserId} yet -- skipping weekly feedback poll`);
      return;
    }
    await sendFeedbackPoll(deps.client, deps.db, deps.ownerUserId, chatId, DEFAULT_WEEKLY_POLL_QUESTION, DEFAULT_WEEKLY_POLL_OPTIONS);
  });

  return {
    unwire() {
      unregisterDreamingCron(deps.ownerUserId);
      unregisterWeeklyExportCron(deps.ownerUserId);
      unsubscribeReflection();
      unregisterScheduledTrigger(pollTriggerId);
    },
  };
}
