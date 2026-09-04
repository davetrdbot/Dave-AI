import cron, { type ScheduledTask } from "node-cron";
import { CronExpressionParser } from "cron-parser";

/**
 * Step 16.2(a): scheduled/time-based automation triggers. Real
 * node-cron scheduling (v4.6, actively maintained) -- confirmed to have
 * no persistence needs of its own for restart-survival: a cron
 * expression's next fire time is recomputed fresh from wall-clock time
 * on every process boot, so re-registering on startup is genuinely
 * sufficient (this is also what Step 18's dreaming cron and Step 19's
 * security-check cron will both do).
 */

export interface ScheduledTrigger {
  id: string;
  expression: string;
  task: ScheduledTask;
}

const registry = new Map<string, ScheduledTrigger>();

export function registerScheduledTrigger(id: string, expression: string, handler: () => void | Promise<void>): ScheduledTrigger {
  if (!cron.validate(expression)) {
    throw new Error(`invalid cron expression: "${expression}"`);
  }
  const task = cron.schedule(expression, handler);
  const trigger: ScheduledTrigger = { id, expression, task };
  registry.set(id, trigger);
  return trigger;
}

export function unregisterScheduledTrigger(id: string): void {
  const trigger = registry.get(id);
  if (!trigger) return;
  trigger.task.stop();
  registry.delete(id);
}

export function listScheduledTriggers(): ScheduledTrigger[] {
  return [...registry.values()];
}

/** Deterministic next-fire-time computation via cron-parser -- no real waiting needed to test correctness. */
export function computeNextFire(expression: string, from = new Date()): Date {
  const interval = CronExpressionParser.parse(expression, { currentDate: from });
  return interval.next().toDate();
}
