import type { DaveDatabase } from "@dave/db";

/** Real, persisted per-user Telegram bot credentials -- confirmed live only after a real OTP round trip (see telegram-otp.ts). */
const TABLE = "telegram_credentials";

export interface TelegramCredentials {
  botToken: string;
  chatId: number;
}

function ensureTable(db: DaveDatabase): void {
  db.createTable(TABLE, [
    { name: "bot_token", type: "TEXT" },
    { name: "chat_id", type: "TEXT" },
  ]);
}

export function setTelegramCredentials(db: DaveDatabase, userId: string, creds: TelegramCredentials): void {
  ensureTable(db);
  const existing = db.query(TABLE, userId, {});
  if (existing.length > 0) {
    db.update(TABLE, userId, existing[0].id as string, { bot_token: creds.botToken, chat_id: String(creds.chatId) });
  } else {
    db.insert(TABLE, userId, { bot_token: creds.botToken, chat_id: String(creds.chatId) });
  }
}

export function getTelegramCredentials(db: DaveDatabase, userId: string): TelegramCredentials | undefined {
  ensureTable(db);
  const rows = db.query(TABLE, userId, {});
  if (rows.length === 0) return undefined;
  return { botToken: rows[0].bot_token as string, chatId: Number(rows[0].chat_id) };
}
