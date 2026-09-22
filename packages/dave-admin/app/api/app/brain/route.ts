import { NextResponse } from "next/server";
import { readMemoryEntries, FROZEN_PAIR_CHAR_BUDGET } from "@dave/memory";
import { knowledgeList } from "@dave/knowledge";
import { withDevice } from "../../../../server/require-device.js";

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

export const GET = withDevice(async ({ userId }) => {
  const userFacts = readMemoryEntries(userId, "user");
  const notes = readMemoryEntries(userId, "memory");
  const usedChars = [...userFacts, ...notes].join("").length;

  const knowledge = knowledgeList(userId);

  return NextResponse.json({
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
  });
});
