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

/**
 * Real bug fixed (user, with a real provider error: "Tool message with tool_call_id 'call_xxx'
 * not found in assistant tool calls. Available tool call IDs: []"): the old trim did a blind
 * `slice(rest.length - N)` from the end -- if that cut point landed between an assistant
 * message's real `toolCalls` and the "tool" role message(s) that answer them, the assistant
 * message got dropped while its orphaned tool-result message(s) survived, sent to the provider
 * with a toolCallId that matches nothing in the retained history. Every real provider correctly
 * rejects that as malformed.
 *
 * Fixed by trimming on TURN boundaries: an assistant message with `toolCalls` and every "tool"
 * role message answering those specific call ids are grouped into one atomic block that is either
 * kept or dropped together -- never split. Every other message (a plain user/assistant turn) is
 * its own block. Blocks are taken from the end until the cap is reached.
 */
function trimHistory(history: CompletionMessage[]): CompletionMessage[] {
  if (history.length <= MAX_MESSAGES) return history;
  const leadingSystem = history[0]?.role === "system" ? [history[0]] : [];
  const rest = history.slice(leadingSystem.length);
  const budget = MAX_MESSAGES - leadingSystem.length;

  const blocks: CompletionMessage[][] = [];
  for (let i = 0; i < rest.length; i++) {
    const msg = rest[i];
    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      const callIds = new Set(msg.toolCalls.map((c) => c.id));
      const block = [msg];
      let j = i + 1;
      while (j < rest.length && rest[j].role === "tool" && rest[j].toolCallId && callIds.has(rest[j].toolCallId!)) {
        block.push(rest[j]);
        j++;
      }
      blocks.push(block);
      i = j - 1;
    } else {
      blocks.push([msg]);
    }
  }

  const keptBlocks: CompletionMessage[][] = [];
  let count = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (count + blocks[i].length > budget) break;
    keptBlocks.unshift(blocks[i]);
    count += blocks[i].length;
  }
  return [...leadingSystem, ...keptBlocks.flat()];
}

export function clearConversationHistory(db: DaveDatabase, userId: string): void {
  db.createTable(TABLE, [{ name: "messages_json", type: "TEXT" }]);
  const rows = db.query(TABLE, userId, {});
  for (const row of rows) db.deleteRow(TABLE, userId, row.id as string);
}
