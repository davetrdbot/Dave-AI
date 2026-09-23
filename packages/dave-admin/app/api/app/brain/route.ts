import { NextResponse } from "next/server";
import {
  readMemoryEntries,
  FROZEN_PAIR_CHAR_BUDGET,
  applyMemoryOperations,
  resetUserMemory,
  clearMemoryTiers,
  MemoryEntryNotFoundError,
  MemoryBatchTooLargeError,
  MemoryBudgetExceededError,
  type MemoryOperation,
} from "@dave/memory";
import { knowledgeList, knowledgeView, knowledgeDraft, knowledgeSave, knowledgeDelete, KnowledgeEntryNotFoundError } from "@dave/knowledge";
import { withDevice } from "../../../../server/require-device";

/**
 * The brain: everything Dave durably knows, in the two stores it actually keeps.
 *
 * The distinction matters and the app should show it, because it is the difference between the
 * two halves of the trader's "lifetime brain":
 *   - MEMORY is about the person. Small, hard-capped, loaded into every single turn, wiped by
 *     /reset. Its size is the interesting thing about it, so the budget is reported.
 *   - KNOWLEDGE is about markets and Dave's own trading. Unbounded, titled, survives a reset.
 *     Each entry carries a "use when" trigger, which is how Dave finds it mid-cycle.
 *
 * Knowledge bodies are NOT returned here. The index is what a browsing screen needs, and a year
 * of accumulated lessons is a lot to push to a phone that is only going to render a list -- the
 * same reason list_skills stopped returning skill bodies. `chars` tells the app what opening one
 * would cost.
 */

function snapshot(userId: string) {
  const userFacts = readMemoryEntries(userId, "user");
  const notes = readMemoryEntries(userId, "memory");
  const usedChars = [...userFacts, ...notes].join("").length;

  const knowledge = knowledgeList(userId);

  return {
    memory: {
      user: userFacts,
      notes,
      usedChars,
      budgetChars: FROZEN_PAIR_CHAR_BUDGET,
      usagePercent: Math.round((usedChars / FROZEN_PAIR_CHAR_BUDGET) * 100),
      entryCount: userFacts.length + notes.length,
    },
    knowledge: {
      count: knowledge.length,
      entries: knowledge.map((k) => ({
        id: k.id,
        title: k.title,
        useWhen: k.useWhen,
        createdAt: k.createdAt,
        chars: k.content.length,
      })),
    },
  };
}

/** `?knowledgeId=` returns one entry in full -- what opening it in the app shows. */
export const GET = withDevice(async ({ userId, req }) => {
  const id = req.nextUrl.searchParams.get("knowledgeId");
  if (id) {
    try {
      return NextResponse.json(knowledgeView(userId, id));
    } catch (err) {
      if (err instanceof KnowledgeEntryNotFoundError) return NextResponse.json({ error: "That lesson no longer exists." }, { status: 404 });
      throw err;
    }
  }
  return NextResponse.json(snapshot(userId));
});

/**
 * The trader writing to Dave's brain by hand.
 *
 * Memory edits go through applyMemoryOperations -- the exact path Dave's own memory tool uses --
 * so the character budget and entry matching are enforced the same way for both. `target` is
 * "user" (about you) or "memory" (notes).
 *
 * Knowledge is added with the store's own draft-then-save, done in one step here: the trader
 * typing a lesson IS the review a draft exists for.
 *
 * `reset-memory` clears what Dave knows about the trader (both memory files and the recall
 * tiers). Knowledge is untouched on purpose -- it is about markets, and the Telegram /reset keeps
 * it too.
 */
export const POST = withDevice(async ({ userId, req }) => {
  let body: { action?: string; target?: string; content?: string; oldText?: string; title?: string; useWhen?: string; id?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const target = body.target === "user" || body.target === "memory" ? body.target : undefined;
  const content = body.content?.trim();

  try {
    switch (body.action) {
      case "memory-add":
      case "memory-replace":
      case "memory-remove": {
        if (!target) return NextResponse.json({ error: 'target must be "user" or "memory".' }, { status: 400 });
        let op: MemoryOperation;
        if (body.action === "memory-add") {
          if (!content) return NextResponse.json({ error: "Write something to save." }, { status: 400 });
          op = { action: "add", target, content };
        } else if (body.action === "memory-replace") {
          if (!content || !body.oldText) return NextResponse.json({ error: "oldText and content are required." }, { status: 400 });
          op = { action: "replace", target, oldText: body.oldText, content };
        } else {
          if (!body.oldText) return NextResponse.json({ error: "oldText is required." }, { status: 400 });
          op = { action: "remove", target, oldText: body.oldText };
        }
        applyMemoryOperations(userId, [op]);
        break;
      }
      case "reset-memory":
        resetUserMemory(userId);
        clearMemoryTiers(userId);
        break;
      case "knowledge-add": {
        const title = body.title?.trim();
        if (!title || !content) return NextResponse.json({ error: "A lesson needs a title and what it says." }, { status: 400 });
        const draft = knowledgeDraft(userId, { title, useWhen: body.useWhen?.trim() ?? "", content });
        knowledgeSave(userId, draft.id);
        break;
      }
      case "knowledge-delete":
        if (!body.id) return NextResponse.json({ error: "id is required." }, { status: 400 });
        knowledgeDelete(userId, body.id);
        break;
      default:
        return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }
  } catch (err) {
    if (err instanceof MemoryEntryNotFoundError || err instanceof KnowledgeEntryNotFoundError) {
      return NextResponse.json({ error: "That entry has changed or no longer exists. Pull to refresh." }, { status: 404 });
    }
    if (err instanceof MemoryBatchTooLargeError || err instanceof MemoryBudgetExceededError) {
      return NextResponse.json({ error: "Memory is full. Remove or shorten an entry first." }, { status: 409 });
    }
    throw err;
  }
  return NextResponse.json(snapshot(userId));
});
