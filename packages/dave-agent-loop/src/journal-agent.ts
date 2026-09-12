import type { DaveDatabase } from "@dave/db";
import type { Provider } from "@dave/brain";
import { FEEDBACK_TOOLS, type FeedbackToolContext } from "@dave/feedback";
import { EA_ANALYSIS_TOOLS, EA_STATE_TOOLS, type EaToolContext } from "@dave/ea-bridge";
import { ToolRegistry, adaptTools } from "./tool-registry.js";
import { AgentLoop, MaxStepsExceededError } from "./agent-loop.js";

/**
 * Real feature (user, live: "Journal is a ai like sidekick... it can ask journal what do you
 * think... it has logs of trade and previous trade and also tool to check analysis... it will
 * review it then place it... it doesn't respond back to Dave [i.e. to the user] -- that's if
 * Dave needs help"). This is a genuine, SEPARATE LLM call Dave can optionally make before
 * committing to a trade -- not a bigger prompt, not a DB helper. Journal has real read/record
 * tools (trade history, analysis, trade comments) but never `trade_execute`/`full_close`/
 * `partial_close` or anything else that can act on the account -- it reviews and comments, it
 * never places or modifies a trade itself. Its output is consumed by the CALLER (the autonomous
 * tick, or a direct chat tool) -- Journal never sends a Telegram message itself.
 *
 * Deliberately reuses the existing, already-tested AgentLoop/ToolRegistry machinery rather than
 * a bespoke loop -- this is a second real agent, not new plumbing.
 */
export interface JournalContext {
  userId: string;
  db: DaveDatabase;
  provider: Provider;
}

const JOURNAL_SYSTEM_PROMPT = `You are Journal, Dave's trade-review sidekick.

Dave (the autonomous trading AI) sometimes asks for your honest, specific opinion before committing to a setup, or asks you to look into an existing position/pending order. You have real tools to check: trade history and lifecycle (did a trade's TP/SL hit, is it still open), the full real market analysis suite for any symbol, and you can add a timestamped comment to an existing trade's record.

You review, you record, you never act. You do not have access to trade_execute, full_close, partial_close, or any tool that places or modifies a trade -- if asked to do one of those, say plainly that's not something you can do, only Dave can.

Answer directly and honestly -- take the setup or don't, say why, specifically. This is an internal consult between you and Dave, never seen directly by the user unless Dave chooses to relay it. Keep your answer focused and real -- no hedging, no filler.`;

/** Real, separate agent run -- one real provider.generate()-backed AgentLoop, scoped to a
 *  read/record-only tool registry. Returns Journal's own final text as its "opinion". */
export async function consultJournal(ctx: JournalContext, question: string, contextLines: string[] = []): Promise<{ opinion: string }> {
  const registry = new ToolRegistry();
  const feedbackCtx: FeedbackToolContext = { userId: ctx.userId, db: ctx.db };
  const eaCtx: EaToolContext = { userId: ctx.userId };
  registry.register(adaptTools(FEEDBACK_TOOLS, feedbackCtx));
  registry.register(adaptTools(EA_STATE_TOOLS, eaCtx));
  registry.register(adaptTools(EA_ANALYSIS_TOOLS, eaCtx));

  const loop = new AgentLoop(ctx.provider, registry);
  const userContent = [question, ...contextLines].join("\n");
  // Real bug fixed (caught live: a stuck autonomous cycle turned out to be a container restart
  // racing a busy-flag staleness window, but Journal's own loop had no step cap at all --
  // agent-loop.ts's real default is Infinity steps. Consulting Journal happens INSIDE a single
  // autonomous tick, which is meant to be reasonably bounded -- an unbounded Journal exploration
  // (e.g. repeatedly calling a 300s-timeout analysis tool) could otherwise block the whole tick
  // for a very long time. Capped to a real, generous-but-finite number of steps.
  const result = await loop.run(
    [
      { role: "system", content: JOURNAL_SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
    { timeoutMs: 60_000, maxSteps: 5 }
  ).catch((err) => {
    if (err instanceof MaxStepsExceededError) return null;
    throw err;
  });

  if (!result) return { opinion: "Journal ran out of steps without reaching a real opinion -- proceed on your own read." };
  if (result.status === "done") return { opinion: result.text };
  // Journal has no ask_user tool registered, so this should never genuinely happen -- but if the
  // underlying loop ever paused for one anyway, report that honestly rather than pretend an
  // opinion was given.
  return { opinion: "Journal couldn't reach a real opinion this time (its own loop paused unexpectedly) -- proceed on your own read." };
}
