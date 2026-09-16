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

/**
 * Background-check tool's polling primitive. `registerScheduledTrigger` above is CRON-ONLY -- a
 * recurring, calendar-anchored schedule, not "poll every N ms until some condition fires or a
 * deadline passes, then stop." Rather than bolting one-shot/self-unregistering semantics onto the
 * cron helper (which node-cron's `ScheduledTask` doesn't naturally support), this is a genuinely
 * separate, simpler `setInterval`-based sibling -- same registry-map shape and stop/list API as
 * `registerScheduledTrigger` for consistency, but interval-driven, not expression-driven.
 *
 * The handler itself decides whether the check is done: returning (or resolving to) `true` from
 * `handler()` self-unregisters the poll immediately (condition met / terminal state reached) --
 * the caller never has to remember to call `unregisterPollingCheck` from inside its own handler.
 * A handler that never returns `true` keeps polling until the caller explicitly stops it (or its
 * own deadline logic, layered on top of this, makes it return `true`) -- this primitive has no
 * opinion on "maxDuration"; that's enforced by whoever calls this (background-check-tools.ts /
 * background-check-loop.ts).
 */
export interface PollingCheck {
  id: string;
  intervalMs: number;
  timer: NodeJS.Timeout;
}

const pollingRegistry = new Map<string, PollingCheck>();

export function registerPollingCheck(id: string, intervalMs: number, handler: () => boolean | void | Promise<boolean | void>): PollingCheck {
  if (pollingRegistry.has(id)) {
    throw new Error(`polling check "${id}" is already registered`);
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`invalid polling interval: ${intervalMs}ms`);
  }
  let running = false;
  const timer = setInterval(() => {
    if (running) return; // a slow previous tick is still in flight -- never overlap ticks
    running = true;
    void (async () => {
      try {
        const done = await handler();
        if (done) unregisterPollingCheck(id);
      } finally {
        running = false;
      }
    })();
  }, intervalMs);
  const check: PollingCheck = { id, intervalMs, timer };
  pollingRegistry.set(id, check);
  return check;
}

export function unregisterPollingCheck(id: string): void {
  const check = pollingRegistry.get(id);
  if (!check) return;
  clearInterval(check.timer);
  pollingRegistry.delete(id);
}

export function listPollingChecks(): PollingCheck[] {
  return [...pollingRegistry.values()];
}
