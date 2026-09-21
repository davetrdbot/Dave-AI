import { existsSync, readFileSync, statSync } from "node:fs";
import type { DaveDatabase } from "@dave/db";
import { markdownToTelegramHtml, type TelegramClient } from "@dave/telegram";
import { KNOWLEDGE_TOOLS, knowledgeList } from "@dave/knowledge";
import { E2B_TOOLS } from "@dave/e2b";
import type { WeeklyExportResult } from "@dave/feedback";
import { ToolRegistry, adaptTools } from "./tool-registry.js";
import { AgentLoop } from "./agent-loop.js";
import { modelConfigProvider } from "./provider-selection.js";

/**
 * Real automation added (the trader, pointing at the export message Dave already sends: "this add
 * that above to be like a automation so when this come it automatically read through this then
 * create a knowledge").
 *
 * The weekly export already wrote a real dataset -- every trade, every skip, every hypothesis --
 * and then did nothing with it but announce a filename. Nobody opens that file. This closes the
 * loop: the moment the export lands, Dave reads it and writes down what he actually learned, so
 * the dataset turns into knowledge he carries into later decisions instead of a dead artifact.
 *
 * The export is handed to a REAL sandbox as a file and analysed with a REAL script rather than
 * being pasted into the prompt for the model to eyeball. That matters at this size: 167 trades of
 * JSON is both too big to reason over reliably by eye and exactly the kind of thing a few lines of
 * Python answer exactly -- win rate by symbol, by session, by R-multiple, holding time against
 * outcome. Conclusions come from arithmetic that genuinely ran, not from an impression of a blob
 * of JSON.
 */

/** Enough of the file to describe it honestly in the prompt; the real analysis happens on the full
 *  file inside the sandbox, not on this excerpt. */
const PREVIEW_CHARS = 4_000;
/** Telegram's own practical message ceiling is ~4096; the summary Dave writes is meant to be a few
 *  lines, and anything past this is a runaway rather than a report. */
const MAX_SUMMARY_CHARS = 3_000;

export interface WeeklyExportReviewDeps {
  db: DaveDatabase;
  client: TelegramClient;
  ownerUserId: string;
  chatId: number;
}

export interface WeeklyExportReviewOutcome {
  status: "written" | "nothing_to_learn" | "export_missing" | "failed";
  knowledgeAdded: number;
  summary: string;
}

export function buildExportReviewPrompt(result: WeeklyExportResult, preview: string, truncated: boolean): string {
  return [
    "The weekly dataset export just ran. Your job is to genuinely LEARN from it and write down what you learned, so it shapes how you trade from here.",
    "",
    `The export covers ${result.tradeCount} trades, ${result.skipCount} skips, and ${result.hypothesisCount} hypotheses.`,
    `Its full contents are attached to your sandbox as "export.json" (in $DAVE_IN_DIR).`,
    "",
    `Here is the start of the file so you know its real shape${truncated ? " (truncated -- the sandbox copy is complete)" : ""}:`,
    "```json",
    preview,
    "```",
    "",
    "Do this:",
    "1. Call run_script with filesIn containing export.json and write real code (python is easiest) to analyse the WHOLE file. Compute things that actually decide something: win rate and expectancy by symbol, by session, by direction; how the winners differ from the losers; whether the skips were right; which hypotheses the data confirms or kills; whether holding time, time of day, or R-multiple separates good trades from bad. Print your numbers.",
    "2. Look at what came back. If a number surprises you, dig into it with another script rather than explaining it away.",
    "3. Call knowledge_list first to see what you already know -- do not write a near-duplicate of something already there. If the new data CONTRADICTS something you wrote before, that is the most valuable thing here: write the correction and say what changed your mind.",
    "4. For each genuine, decision-changing finding, call knowledge_draft then knowledge_save. Write each one so it is useful at the moment of a trade: a specific, concrete rule with the real numbers behind it and the sample size it rests on.",
    "",
    "Hard rules, because a wrong lesson is worse than no lesson:",
    "- Only write what the numbers genuinely support. Never write a lesson you did not actually measure.",
    "- Always carry the sample size. A pattern over 4 trades is an anecdote; say so rather than stating it as a rule.",
    "- If the data honestly does not support any new lesson, write NOTHING and say so. That is a real, acceptable outcome.",
    "",
    "When you are done, reply in plain text with a short summary for the trader: what you found and what you wrote down (or that you found nothing solid enough to write). Keep it to a few lines.",
  ].join("\n");
}

/**
 * Runs the real review. Returns rather than throws -- this is called from a cron handler, where an
 * unhandled rejection would take the whole trading process down over a weekly report.
 */
export async function reviewWeeklyExport(deps: WeeklyExportReviewDeps, result: WeeklyExportResult): Promise<WeeklyExportReviewOutcome> {
  if (!existsSync(result.path)) {
    return { status: "export_missing", knowledgeAdded: 0, summary: `The export file ${result.path} was not on disk when the review ran.` };
  }

  const raw = readFileSync(result.path, "utf8");
  const preview = raw.slice(0, PREVIEW_CHARS);
  const before = knowledgeList(deps.ownerUserId).length;

  const registry = new ToolRegistry();
  registry.register(adaptTools(KNOWLEDGE_TOOLS, { userId: deps.ownerUserId }));
  // Only run_script -- this job analyses a file, it has no business touching stored E2B keys.
  const runScript = E2B_TOOLS.find((t) => t.name === "run_script");
  if (runScript) registry.register(adaptTools([runScript], { userId: deps.ownerUserId, db: deps.db }));

  const provider = modelConfigProvider(deps.db, deps.ownerUserId, () => undefined);
  const loop = new AgentLoop(provider, registry);
  const task = buildExportReviewPrompt(result, preview, raw.length > PREVIEW_CHARS);

  try {
    // Uncapped steps, like every other real agent run here: analysing a dataset is genuinely
    // iterative (run, read, dig, correct) and a step cap would cut it off mid-thought. The
    // AgentLoop's own wall-clock deadline is the real ceiling.
    const run = await loop.run([
      {
        role: "system",
        content:
          "You are Dave, reviewing your own trading dataset. You have run_script (real bash/python/node in a sandbox, with the export attached) and your knowledge tools. Measure before you conclude, and never write a lesson the data does not genuinely support.",
      },
      { role: "user", content: task },
    ]);

    const added = knowledgeList(deps.ownerUserId).length - before;
    const text = run.status === "done" ? run.text.trim() : "";

    if (run.status !== "done") {
      return { status: "failed", knowledgeAdded: added, summary: `The review stopped early (${run.status}).` };
    }
    return {
      status: added > 0 ? "written" : "nothing_to_learn",
      knowledgeAdded: added,
      summary: text.slice(0, MAX_SUMMARY_CHARS) || (added > 0 ? `Wrote ${added} new knowledge entr${added === 1 ? "y" : "ies"}.` : "Nothing in this week's data was solid enough to write down."),
    };
  } catch (err) {
    return { status: "failed", knowledgeAdded: knowledgeList(deps.ownerUserId).length - before, summary: err instanceof Error ? err.message : String(err) };
  }
}

/** The message the trader actually sees once the review has run. */
export function composeReviewMessage(result: WeeklyExportResult, outcome: WeeklyExportReviewOutcome): string {
  const header = `<b>🗂️ Weekly dataset export</b>\n${result.tradeCount} trades, ${result.skipCount} skips, ${result.hypothesisCount} hypotheses written to <code>${result.path}</code>`;
  if (outcome.status === "export_missing" || outcome.status === "failed") {
    return `${header}\n\n⚠️ I couldn't finish reviewing it: ${outcome.summary}`;
  }
  const learned = outcome.knowledgeAdded > 0 ? `\n\n📚 Wrote ${outcome.knowledgeAdded} new knowledge entr${outcome.knowledgeAdded === 1 ? "y" : "ies"} from it.` : "\n\n📚 Nothing this week was solid enough to write down as a rule.";
  return `${header}${learned}\n\n${markdownToTelegramHtml(outcome.summary)}`;
}

/** Size guard for the caller's own logging -- a review over a genuinely huge export is worth
 *  noticing, since the sandbox copy and the model's own reading both scale with it. */
export function exportSizeBytes(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}
