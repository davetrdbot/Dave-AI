import { randomInt } from "node:crypto";
import type { DaveDatabase } from "@dave/db";
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

/** Step 1: real getMe() validation, then generates and stores a real pending OTP. */
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
  return { otp, botUsername: me.username };
}

/** Step 2: real getUpdates() against the real bot -- confirms once the user's own message text matches the stored OTP. */
export async function checkTelegramOtpPairing(db: DaveDatabase, userId: string): Promise<{ confirmed: boolean; reason?: string }> {
  ensureTable(db);
  const rows = db.query(TABLE, userId, {}) as unknown as PendingOtpRow[];
  if (rows.length === 0) return { confirmed: false, reason: "no pending pairing -- call start first" };
  const pending = rows[0];

  const client = new TelegramClient(pending.bot_token);
  const updates = await client.getUpdates({ timeout: 0 });
  const chatId = Number(pending.chat_id);
  const matched = updates.some((u) => u.message?.chat.id === chatId && u.message.text?.trim() === pending.otp);
  if (!matched) return { confirmed: false, reason: "OTP not seen yet -- paste it into the bot chat and check again" };

  setTelegramCredentials(db, userId, { botToken: pending.bot_token, chatId });
  db.deleteRow(TABLE, userId, pending.id);
  return { confirmed: true };
}

export function getTelegramPairingStatus(db: DaveDatabase, userId: string): { paired: boolean; chatId?: number } {
  const creds = getTelegramCredentials(db, userId);
  return creds ? { paired: true, chatId: creds.chatId } : { paired: false };
}

export type { TelegramCredentials };
