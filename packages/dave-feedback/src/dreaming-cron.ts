import { registerScheduledTrigger, unregisterScheduledTrigger, type ScheduledTrigger } from "@dave/db";
import { createWorker, retireWorker, type Worker } from "@dave/workers";
import type { DaveDatabase } from "@dave/db";
import { listTradesSince } from "./trade-log.js";
import { readSkipLog } from "./skip-log.js";
import { readHypotheses } from "./hypotheses.js";

/**
 * Step 18.1: the dreaming cron. Real `node-cron` scheduling (Step
 * 16.2a), default DAILY (`0 3 * * *` -- 03:00 UTC every day), a
 * real customizable expression per user. "Run through a worker" is
 * literal here, not a figure of speech: a real `journal`-role worker
 * (Step 12) is created for the run and retired immediately after, the
 * same lifecycle any other worker task goes through -- this is not an
 * inline callback pretending to be a worker.
 */

/**
 * Real change (the trader: "what's the point of self improvement if it's only 1 week / so make it
 * 1 day"). A weekly reflection means a lesson learned on Monday sits unused until the following
 * Sunday -- six days of trading on knowledge the data had already contradicted. Daily closes that
 * gap. The run is cheap (it reads already-persisted trade/skip records), and a day with nothing
 * worth concluding is an accepted, explicitly-handled outcome, so a quiet day costs nothing.
 */
export const DEFAULT_DREAMING_CRON = "0 3 * * *";

export interface DreamingInput {
  allTradesEver: ReturnType<typeof listTradesSince>;
  allSkipsEver: ReturnType<typeof readSkipLog>;
  hypotheses: ReturnType<typeof readHypotheses>;
}

export function registerDreamingCron(
  db: DaveDatabase,
  ownerUserId: string,
  onDream: (worker: Worker, input: DreamingInput) => void | Promise<void>,
  cronExpression: string = DEFAULT_DREAMING_CRON
): ScheduledTrigger {
  return registerScheduledTrigger(`dreaming-${ownerUserId}`, cronExpression, async () => {
    const worker = createWorker(ownerUserId, { assignment: "temporary", role: "journal", task: "Weekly dreaming reflection" });
    try {
      const input: DreamingInput = {
        allTradesEver: listTradesSince(db, ownerUserId, 0),
        allSkipsEver: readSkipLog(ownerUserId),
        hypotheses: readHypotheses(ownerUserId),
      };
      await onDream(worker, input);
    } finally {
      retireWorker(ownerUserId, worker.id);
    }
  });
}

export function unregisterDreamingCron(ownerUserId: string): void {
  unregisterScheduledTrigger(`dreaming-${ownerUserId}`);
}
