import type { DaveDatabase } from "@dave/db";
import { recordSkip, readSkipLog } from "./skip-log.js";
import { recordHypothesis, recordObservation, readHypotheses, type Observation } from "./hypotheses.js";
import { getReflectionThreshold, setReflectionThreshold } from "./reflection.js";
import { getTodaysWinRateSummary, getWinRateSummary } from "./closed-trade-log.js";

/**
 * Real gap this closes: Step 18 built genuinely real, tested logic for
 * the skip log and hypotheses.jsonl (18.3/18.4), but nothing in
 * production ever called `recordSkip`/`recordHypothesis`/
 * `recordObservation` -- they existed only as functions the step-18 test
 * called directly. Dave's own reasoning (deciding to skip a setup,
 * forming a hypothesis about market behavior, later judging whether a
 * cycle supported or contradicted it) is exactly the kind of judgment
 * this codebase always exposes as an agent-callable tool rather than
 * inferring automatically -- same boundary as `journal_trade` for the
 * trade journal.
 */

export interface FeedbackToolContext {
  userId: string;
  db: DaveDatabase;
}

export interface FeedbackToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: FeedbackToolContext) => Promise<unknown>;
}

export const FEEDBACK_TOOLS: FeedbackToolDefinition[] = [
  {
    name: "record_skip",
    description: "Log a real setup you looked at and chose NOT to trade, and why -- feeds the skip log a weekly reflection reads (separate from the trade journal).",
    parameters: {
      type: "object",
      properties: { symbol: { type: "string" }, reason: { type: "string" } },
      required: ["symbol", "reason"],
    },
    execute: async (args, ctx) => {
      recordSkip(ctx.userId, args.symbol as string, args.reason as string);
      return { recorded: true, symbol: args.symbol, reason: args.reason };
    },
  },
  {
    name: "list_skips",
    description: "Get every real logged skip (setup passed on, and why) for this account.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => readSkipLog(ctx.userId),
  },
  {
    name: "record_hypothesis",
    description: "Record a real hypothesis about market/strategy behavior you want to test over time (e.g. 'liquidity sweeps at London open tend to reverse within 2H'). Returns a hypothesisId to record observations against.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    execute: async (args, ctx) => ({ hypothesisId: recordHypothesis(ctx.userId, args.text as string) }),
  },
  {
    name: "record_observation",
    description: "Record whether a real trading cycle supported or contradicted an existing hypothesis. The verdict only settles (confirmed/failed) after enough real cycles -- never before.",
    parameters: {
      type: "object",
      properties: { hypothesisId: { type: "string" }, observation: { type: "string", enum: ["supports", "contradicts"] } },
      required: ["hypothesisId", "observation"],
    },
    execute: async (args, ctx) => {
      recordObservation(ctx.userId, args.hypothesisId as string, args.observation as Observation);
      return readHypotheses(ctx.userId).find((h) => h.id === args.hypothesisId);
    },
  },
  {
    name: "list_hypotheses",
    description: "Get every real hypothesis on record for this account, with its current verdict (pending/confirmed/failed) and support/contradict counts.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => readHypotheses(ctx.userId),
  },
  {
    name: "get_reflection_threshold",
    description: "Get the real number of new trades that triggers an automatic trade-count reflection (default 10).",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => ({ threshold: getReflectionThreshold(ctx.db, ctx.userId) }),
  },
  {
    name: "set_reflection_threshold",
    description: "Change the real number of new trades that triggers an automatic trade-count reflection.",
    parameters: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
    execute: async (args, ctx) => {
      setReflectionThreshold(ctx.db, ctx.userId, args.n as number);
      return { threshold: getReflectionThreshold(ctx.db, ctx.userId) };
    },
  },
  {
    name: "get_todays_journal",
    description: "Real 'journal of the day' -- today's real win rate, wins/losses/breakeven count, and net P&L, computed from every real closed trade the EA has reported today (UTC calendar day). Returns winRatePct: null when there are genuinely zero closed trades yet, never a fabricated 0%.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => getTodaysWinRateSummary(ctx.db, ctx.userId),
  },
  {
    name: "get_win_rate",
    description: "Real win rate and P&L over a given number of past days (default 7) -- same real closed-trade data as get_todays_journal, wider window.",
    parameters: { type: "object", properties: { days: { type: "number" } } },
    execute: async (args, ctx) => {
      const days = (args.days as number | undefined) ?? 7;
      return getWinRateSummary(ctx.db, ctx.userId, Date.now() - days * 24 * 60 * 60 * 1000);
    },
  },
];
