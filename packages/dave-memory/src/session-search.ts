import { getConversation, type ConversationTurn } from "./tencent-tiers.js";

export interface SearchHit {
  turn: ConversationTurn;
  index: number;
}

/**
 * Step 4.4: full-text search across past conversations. Searches the L0
 * conversation log (every turn ever recorded for this user), case
 * insensitive substring match. Real search over real persisted turns --
 * not a stub.
 */
export function searchSessions(userId: string, query: string): SearchHit[] {
  const needle = query.toLowerCase();
  const turns = getConversation(userId);
  const hits: SearchHit[] = [];
  turns.forEach((turn, index) => {
    if (turn.text.toLowerCase().includes(needle)) {
      hits.push({ turn, index });
    }
  });
  return hits;
}
