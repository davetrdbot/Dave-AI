import type { DaveDatabase } from "@dave/db";
import type { CompletionMessage } from "@dave/brain";
import { stripLiveContext } from "./live-context.js";

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

/**
 * Real, measured latency bug fixed (the trader: "responses are slow"). Two things were being
 * written into history and then re-uploaded, verbatim, on EVERY later turn until they aged out of
 * the 60-message window:
 *
 *   1. The per-turn live-context block (live-context.ts). Measured at 663 chars bare, but 30,172
 *      chars once an active strategy skill is set -- its full body is embedded. Across ~30
 *      retained user turns that is ~884 KB / ~226k tokens of stale duplicates per request.
 *   2. Raw tool results. `get_all_analysis` alone returns a real ~24 KB suite (measured against
 *      the EA's own A_All shape, ea/DaveEA.mq5) and agent-loop.ts stores it with
 *      `JSON.stringify(output)` -- so one analysis call keeps paying ~6k tokens on every single
 *      later chat message, for market data that is stale the moment the next candle prints.
 *
 * Both are compacted on the way into storage. Neither can affect the turn that produced them:
 * this runs strictly AFTER the run has finished and the model has already seen the full values.
 * For a trading bot, keeping a stale analysis payload in context is worse than dropping it --
 * the marker below tells the model plainly to re-fetch rather than reason off old prices.
 */
export const MAX_STORED_TOOL_RESULT_CHARS = 4000;

function compactForStorage(history: CompletionMessage[]): CompletionMessage[] {
  return history.map((msg) => {
    if (msg.role === "user") {
      const stripped = stripLiveContext(msg.content);
      return stripped === msg.content ? msg : { ...msg, content: stripped };
    }
    if (msg.role === "tool" && typeof msg.content === "string" && msg.content.length > MAX_STORED_TOOL_RESULT_CHARS) {
      const kept = msg.content.slice(0, MAX_STORED_TOOL_RESULT_CHARS);
      return {
        ...msg,
        content: `${kept}\n\n[... ${msg.content.length - MAX_STORED_TOOL_RESULT_CHARS} more characters of this result were dropped from the saved conversation. It is a past turn's snapshot, not live data -- call the tool again if you need this now.]`,
      };
    }
    return msg;
  });
}

export function loadConversationHistory(db: DaveDatabase, userId: string): CompletionMessage[] {
  db.createTable(TABLE, [{ name: "messages_json", type: "TEXT" }]);
  const rows = db.query(TABLE, userId, {});
  if (rows.length === 0) return [];
  // Compacted on the way out too, so a history the deployed bot already bloated (written before
  // this fix, with no sentinels) genuinely heals on the very next message instead of costing the
  // owner a /reset -- see live-context.ts's LEGACY_BLOCK_TERMINATORS.
  return compactForStorage(JSON.parse(rows[0].messages_json as string));
}

export function saveConversationHistory(db: DaveDatabase, userId: string, history: CompletionMessage[]): void {
  db.createTable(TABLE, [{ name: "messages_json", type: "TEXT" }]);
  const trimmed = compactForStorage(trimHistory(history));
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
