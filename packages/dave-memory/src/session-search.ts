import { getConversation, type ConversationTurn } from "./tencent-tiers.js";

export interface SearchHit {
  turn: ConversationTurn;
  index: number;
  /** How well it matched -- more of the query's words, the whole phrase, and newer rank higher. */
  score: number;
  /** When it was said (UTC), for "when did we talk about...". */
  date: string;
  /** The part of the message around the first match. */
  snippet: string;
}

const STOP_WORDS = new Set("a an the and or of to in on at for is are was were be it this that my me i we you about with what when did do".split(" "));
const MAX_HITS = 10;

/** The words that matter in a query: lower case, no punctuation, no filler, plural "s" dropped. */
function queryWords(query: string): string[] {
  const words = query.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
  return [...new Set(words.map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w)))];
}

function snippetAround(text: string, at: number): string {
  const start = Math.max(0, at - 60);
  const end = Math.min(text.length, at + 140);
  return `${start > 0 ? "..." : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "..." : ""}`;
}

/**
 * Search across every past conversation turn (the L0 log) -- by WORDS in any order, the way
 * Hermes's session search works, not only the exact phrase: "gold stop loss" finds "the stop
 * loss on gold". A turn must contain every word of a short query (1-2 words) or most of a longer
 * one; the whole phrase, more words matched and newer turns rank first. Top 10, each with its
 * date and a snippet.
 */
export function searchSessions(userId: string, query: string): SearchHit[] {
  const words = queryWords(query);
  const phrase = query.toLowerCase().trim();
  if (!words.length && !phrase) return [];
  const needed = words.length <= 2 ? words.length : Math.ceil(words.length * 0.6);
  const turns = getConversation(userId);
  const hits: SearchHit[] = [];
  turns.forEach((turn, index) => {
    const text = turn.text.toLowerCase();
    const phraseAt = phrase ? text.indexOf(phrase) : -1;
    let matched = 0;
    let firstAt = phraseAt;
    for (const w of words) {
      const at = text.indexOf(w);
      if (at < 0) continue;
      matched++;
      if (firstAt < 0 || at < firstAt) firstAt = at;
    }
    if (phraseAt < 0 && (words.length === 0 || matched < needed)) return;
    const recency = turns.length > 1 ? index / (turns.length - 1) : 1; // 0..1, newest = 1
    const score = matched + (phraseAt >= 0 ? words.length + 1 : 0) + recency * 0.5;
    hits.push({ turn, index, score: Math.round(score * 100) / 100, date: new Date(turn.ts).toISOString(), snippet: snippetAround(turn.text, Math.max(0, firstAt)) });
  });
  return hits.sort((a, b) => b.score - a.score || b.index - a.index).slice(0, MAX_HITS);
}
