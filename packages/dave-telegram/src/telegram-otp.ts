import { randomInt } from "node:crypto";
import type { DaveDatabase } from "@dave/db";
import { BootstrapFlow, type Transport } from "@dave/core";
import { TelegramClient } from "./client.js";
import { setTelegramCredentials, getTelegramCredentials, type TelegramCredentials } from "./telegram-credentials.js";

/**
 * Real OTP pairing flow, confirmed direction: the admin website is
 * where the bot token + chat ID get entered. Submitting those makes
 * the WEBSITE generate and display a real OTP code. The user copies
 * that code and pastes it INTO TELEGRAM as a message to their bot. The
 * bot receives that pasted code (via a real getUpdates() poll this
 * flow drives) and confirms the connection -- website generates the
 * code, Telegram is where it gets submitted back, never the other way.
 *
 * Honest architecture note: an admin API route is a single request/
 * response, not a long-running process -- it cannot sit there waiting
 * for a Telegram message to arrive. So `startTelegramOtpPairing`
 * validates the token (a real getMe() call) and stores a pending OTP;
 * `checkTelegramOtpPairing` is the second real step, called again
 * (e.g. the UI polling it every few seconds after showing the OTP) --
 * each call does a real getUpdates() against the real bot and checks
 * whether the pasted message has arrived yet.
 */
const TABLE = "telegram_otp_pairing";

interface PendingOtpRow {
  id: string;
  bot_token: string;
  chat_id: string;
  otp: string;
  created_at: number;
}

function ensureTable(db: DaveDatabase): void {
  db.createTable(TABLE, [
    { name: "bot_token", type: "TEXT" },
    { name: "chat_id", type: "TEXT" },
    { name: "otp", type: "TEXT" },
  ]);
}

export class InvalidTelegramBotTokenError extends Error {
  constructor(cause: unknown) {
    super(`Could not verify this bot token with Telegram's own getMe() -- ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "InvalidTelegramBotTokenError";
  }
}

function generateOtp(): string {
  return String(randomInt(100000, 1000000));
}

/**
 * Real gap fixed: this used to only validate the token and store the
 * OTP -- it never actually told the user, inside Telegram, to paste it
 * back. The OTP was shown ONLY on the admin website; a real user with
 * no prior knowledge of this flow had no way to know what to do next
 * (confirmed report: "generated a code ... didn't even tell me to
 * paste my code"). Now sends a real message to the real chat.
 *
 * Also calls deleteWebhook() first: checkTelegramOtpPairing's
 * getUpdates() polling genuinely CANNOT work while a webhook is
 * registered for this bot (Telegram returns a real 409 conflict) --
 * this guarantees pairing works even if this exact bot token was ever
 * used with a webhook before (a prior deploy, a different tool, an
 * earlier test), not just on a bot that's never touched the API.
 */
export async function startTelegramOtpPairing(db: DaveDatabase, userId: string, botToken: string, chatId: number): Promise<{ otp: string; botUsername: string }> {
  ensureTable(db);
  const client = new TelegramClient(botToken);
  let me: { username: string };
  try {
    me = await client.getMe();
  } catch (err) {
    throw new InvalidTelegramBotTokenError(err);
  }

  const existing = db.query(TABLE, userId, {});
  const otp = generateOtp();
  if (existing.length > 0) {
    db.update(TABLE, userId, existing[0].id as string, { bot_token: botToken, chat_id: String(chatId), otp });
  } else {
    db.insert(TABLE, userId, { bot_token: botToken, chat_id: String(chatId), otp });
  }

  await client.deleteWebhook().catch(() => {}); // best-effort -- proceed even if there was nothing to delete
  await client.sendMessage({
    chat_id: chatId,
    text: `Your pairing code is: ${otp}\n\nSend this exact code back to me here (as a normal message) to finish connecting.`,
  });

  return { otp, botUsername: me.username };
}

/** Step 2: real getUpdates() against the real bot -- confirms once the user's own message text matches the stored OTP. */
export async function checkTelegramOtpPairing(db: DaveDatabase, userId: string): Promise<{ confirmed: boolean; reason?: string }> {
  ensureTable(db);
  const rows = db.query(TABLE, userId, {}) as unknown as PendingOtpRow[];
  if (rows.length === 0) return { confirmed: false, reason: "no pending pairing -- call start first" };
  const pending = rows[0];

  const client = new TelegramClient(pending.bot_token);
  let updates: Awaited<ReturnType<TelegramClient["getUpdates"]>>;
  try {
    updates = await client.getUpdates({ timeout: 0 });
  } catch (err) {
    // Real, confirmed failure mode: getUpdates() 409-conflicts if a
    // webhook is registered for this bot. startTelegramOtpPairing now
    // deletes it up front, but report this honestly instead of a raw
    // throw/500 if it somehow still happens (e.g. a race with another
    // process re-registering the webhook).
    return { confirmed: false, reason: `Could not poll Telegram for your reply: ${err instanceof Error ? err.message : String(err)}` };
  }
  const chatId = Number(pending.chat_id);
  const matched = updates.some((u) => u.message?.chat.id === chatId && u.message.text?.trim() === pending.otp);
  if (!matched) return { confirmed: false, reason: "OTP not seen yet -- paste it into the bot chat and check again" };

  setTelegramCredentials(db, userId, { botToken: pending.bot_token, chatId });
  db.deleteRow(TABLE, userId, pending.id);

  // Real gap fixed (BOOTSTRAP.md was always correct and complete, and dave-core's
  // BootstrapFlow already implemented it exactly, real-task-detection included --
  // it was simply never triggered at the one real moment that matters: pairing
  // genuinely confirmed. This IS that moment; Dave speaks first, unprompted, using
  // the real client/chatId this exact pairing just resolved.
  const transport: Transport = {
    send: async (_userId, text) => {
      await client.sendMessage({ chat_id: chatId, text });
    },
  };
  await new BootstrapFlow(transport).start(userId).catch((err) => {
    console.error(`[telegram-otp] cold-start bootstrap failed to send: ${err instanceof Error ? err.message : String(err)}`);
  });

  return { confirmed: true };
}

export function getTelegramPairingStatus(db: DaveDatabase, userId: string): { paired: boolean; chatId?: number } {
  const creds = getTelegramCredentials(db, userId);
  return creds ? { paired: true, chatId: creds.chatId } : { paired: false };
}

export type { TelegramCredentials };
