import type { DaveDatabase } from "@dave/db";
import type { CompletionMessage } from "@dave/brain";

/**
 * Real, persisted per-user conversation history. Without this, a
 * webhook (or polling) process that restarts -- deploy, crash, host
 * recycle -- genuinely forgets every message so far; the in-memory
 * `history` array a one-off script keeps is not "online 24/7", it's
 * online until the next restart. This survives that: the full message
 * history is written back to the DB after every turn and reloaded at
 * the start of the next one.
 *
 * Capped at MAX_MESSAGES (keeping the most recent ones, and always the
 * leading system message if present) so a long-running bot's own
 * history doesn't grow the prompt without bound.
 */
const TABLE = "conversation_history";
const MAX_MESSAGES = 60;

export function loadConversationHistory(db: DaveDatabase, userId: string): CompletionMessage[] {
  db.createTable(TABLE, [{ name: "messages_json", type: "TEXT" }]);
  const rows = db.query(TABLE, userId, {});
  if (rows.length === 0) return [];
  return JSON.parse(rows[0].messages_json as string);
}

export function saveConversationHistory(db: DaveDatabase, userId: string, history: CompletionMessage[]): void {
  db.createTable(TABLE, [{ name: "messages_json", type: "TEXT" }]);
  const trimmed = trimHistory(history);
  const rows = db.query(TABLE, userId, {});
  const payload = { messages_json: JSON.stringify(trimmed) };
  if (rows.length > 0) db.update(TABLE, userId, rows[0].id as string, payload);
  else db.insert(TABLE, userId, payload);
}

function trimHistory(history: CompletionMessage[]): CompletionMessage[] {
  if (history.length <= MAX_MESSAGES) return history;
  const leadingSystem = history[0]?.role === "system" ? [history[0]] : [];
  const rest = history.slice(leadingSystem.length);
  return [...leadingSystem, ...rest.slice(rest.length - (MAX_MESSAGES - leadingSystem.length))];
}

export function clearConversationHistory(db: DaveDatabase, userId: string): void {
  db.createTable(TABLE, [{ name: "messages_json", type: "TEXT" }]);
  const rows = db.query(TABLE, userId, {});
  for (const row of rows) db.deleteRow(TABLE, userId, row.id as string);
}
