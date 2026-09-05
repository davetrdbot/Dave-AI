import type { DaveDatabase } from "@dave/db";

/**
 * Real gap: proactive pushes that fire on a schedule (the morning
 * brief, and anything else initiated by a cron rather than an incoming
 * message) have no incoming update to read a chatId off of. This
 * persists the last chat the owner actually messaged Dave from, so a
 * scheduled push has somewhere real to go. Updated on every real
 * incoming message/callback in telegram-bot-server.ts's onUpdate.
 */
const TABLE = "primary_chat";

function ensureTable(db: DaveDatabase): void {
  db.createTable(TABLE, [{ name: "chat_id", type: "INTEGER" }]);
}

export function recordActiveChat(db: DaveDatabase, ownerUserId: string, chatId: number): void {
  ensureTable(db);
  const rows = db.query(TABLE, ownerUserId, {});
  if (rows.length > 0) db.update(TABLE, ownerUserId, rows[0].id as string, { chat_id: chatId });
  else db.insert(TABLE, ownerUserId, { chat_id: chatId });
}

export function getPrimaryChatId(db: DaveDatabase, ownerUserId: string): number | undefined {
  ensureTable(db);
  const rows = db.query(TABLE, ownerUserId, {});
  return rows.length > 0 ? (rows[0].chat_id as number) : undefined;
}
