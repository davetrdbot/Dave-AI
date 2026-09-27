import type { CompletionRequest, CompletionResult } from "@dave/brain";
import { appendAdaptability, applyMemoryOperations, getWriteApprovalSetting, readLive, readMemoryEntries, type MemoryOperation } from "@dave/memory";
import type { AgentStep } from "./agent-loop.js";

/**
 * The trader: "it hardly even stores to memory". Saving was left entirely to the model calling
 * remember_* in the middle of a turn -- and a model busy trading mostly doesn't. This runs after
 * every finished chat turn, off the reply's path: one small model call reads just that exchange
 * against what memory already holds, and saves anything lasting the trader said about themselves,
 * their rules or how they want to be talked to. Market lessons stay out (that's knowledge).
 */

export interface MemoryReviewProvider {
  generate(req: CompletionRequest, timeoutMs: number, signal?: AbortSignal): Promise<CompletionResult>;
}

const WROTE_MEMORY = /^(remember_user_fact|remember_note|remember_adaptability_note|edit_memory)$/;
const SMALL_TALK_WORDS = new Set("ok okay k yes yeah yep ya no nope thanks thank you thx ty cool nice good great lol hmm alright sure done fine wow bro nah please pls".split(" "));
/** "ok thanks", "yeah bro 👍" -- nothing in it could be worth remembering. */
const isSmallTalk = (text: string) => {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  return words.every((w) => SMALL_TALK_WORDS.has(w));
};

function reviewPrompt(userText: string, replyText: string, memory: string[], user: string[], adaptability: string): string {
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "(empty)");
  return [
    "You maintain the long-term memory of Dave, a trading assistant, about the ONE trader he works for.",
    "Read the exchange below and decide whether the TRADER said anything worth remembering for months:",
    "- facts about them (name, accounts, broker, capital, schedule, experience) -> target \"user\"",
    "- standing instructions and rules (\"only trade synthetics\", \"always use 0.05 lots\", \"never trade gold\") -> target \"user\"",
    "- lasting decisions or context worth carrying -> target \"memory\"",
    "- how they want to be talked to (short answers, language, no emojis, don't message at night) -> \"adaptability\"",
    "Do NOT save: market prices, today's analysis, one-off requests (\"buy gold now\"), anything that will be stale in a week, or anything already stored below.",
    "Write each entry as a short plain fact in the third person (\"They only trade Boom and Crash.\"), never as an order.",
    "If something they said updates an entry below, replace it (oldText = an exact substring of that entry).",
    "",
    "Stored now -- user:",
    list(user),
    "Stored now -- memory:",
    list(memory),
    "Stored now -- adaptability:",
    adaptability.trim() || "(empty)",
    "",
    "The exchange:",
    `TRADER: ${userText.slice(0, 4000)}`,
    `DAVE: ${replyText.slice(0, 2000)}`,
    "",
    'Answer with JSON only: {"operations":[{"action":"add","target":"user","content":"..."} | {"action":"replace","target":"user","oldText":"...","content":"..."} | {"action":"remove","target":"memory","oldText":"..."}],"adaptability":["..."]}',
    'Nothing worth saving (the usual case) -> {"operations":[],"adaptability":[]}',
  ].join("\n");
}

function parseReview(text: string): { operations: MemoryOperation[]; adaptability: string[] } {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { operations: [], adaptability: [] };
  let raw: { operations?: unknown; adaptability?: unknown };
  try {
    raw = JSON.parse(match[0]);
  } catch {
    return { operations: [], adaptability: [] };
  }
  const ops = (Array.isArray(raw.operations) ? raw.operations : []).filter((o): o is MemoryOperation => {
    const op = o as Record<string, unknown>;
    if (op?.target !== "user" && op?.target !== "memory") return false;
    if (op.action === "add") return typeof op.content === "string" && op.content.trim().length > 3;
    if (op.action === "replace") return typeof op.oldText === "string" && typeof op.content === "string" && !!op.oldText && op.content.trim().length > 3;
    if (op.action === "remove") return typeof op.oldText === "string" && !!op.oldText;
    return false;
  });
  const adaptability = (Array.isArray(raw.adaptability) ? raw.adaptability : []).filter((a): a is string => typeof a === "string" && a.trim().length > 3);
  return { operations: ops.slice(0, 5), adaptability: adaptability.slice(0, 3) };
}

/** What was saved, as plain lines (empty when nothing was). Never throws. */
export async function autoSaveMemory(
  provider: MemoryReviewProvider,
  userId: string,
  exchange: { userText: string; replyText: string; steps?: AgentStep[] },
): Promise<string[]> {
  try {
    const userText = exchange.userText.trim();
    if (userText.length < 8 || isSmallTalk(userText)) return [];
    // Dave already saved something this turn -- don't second-guess it with a duplicate.
    if (exchange.steps?.some((s) => WROTE_MEMORY.test(s.toolName) && !s.isError)) return [];
    // The trader asked to approve every memory write: that choice stands.
    if (getWriteApprovalSetting(userId)) return [];

    const memory = readMemoryEntries(userId, "memory");
    const user = readMemoryEntries(userId, "user");
    const adaptabilityNow = readLive(userId, "ADAPTABILITY.md");
    const result = await provider.generate({ messages: [{ role: "user", content: reviewPrompt(userText, exchange.replyText, memory, user, adaptabilityNow) }], tools: [] }, 45_000);
    const { operations, adaptability } = parseReview(result.text ?? "");

    const saved: string[] = [];
    if (operations.length) {
      try {
        applyMemoryOperations(userId, operations);
        for (const op of operations) saved.push(op.action === "remove" ? `forgot: ${op.oldText}` : op.content);
      } catch (err) {
        // Full or a stale oldText: try the plain adds alone, which is what matters most.
        const adds = operations.filter((o) => o.action === "add");
        if (adds.length && adds.length !== operations.length) {
          try {
            applyMemoryOperations(userId, adds);
            for (const op of adds) saved.push(op.content);
          } catch {
            console.warn(`[memory-autosave] ${userId}: couldn't save (${err instanceof Error ? err.message.slice(0, 120) : String(err)})`);
          }
        } else {
          console.warn(`[memory-autosave] ${userId}: couldn't save (${err instanceof Error ? err.message.slice(0, 120) : String(err)})`);
        }
      }
    }
    const have = adaptabilityNow.toLowerCase();
    for (const a of adaptability) {
      if (have.includes(a.trim().toLowerCase())) continue;
      appendAdaptability(userId, a.trim());
      saved.push(a.trim());
    }
    if (saved.length) console.log(`[memory-autosave] ${userId}: saved ${saved.length} item(s)`);
    return saved;
  } catch (err) {
    console.warn(`[memory-autosave] ${userId}: review failed (${err instanceof Error ? err.message.slice(0, 120) : String(err)})`);
    return [];
  }
}
