import type { DaveDatabase } from "./database.js";
import { listAutomations, type Automation } from "./automation-store.js";
import { registerScheduledTrigger, unregisterScheduledTrigger } from "./scheduled-trigger.js";

/**
 * Part 3 (B4): "confirm this connects to real triggers actually firing,
 * not just database rows sitting unused." This is that connection --
 * every enabled "scheduled" automation gets a REAL node-cron trigger
 * (scheduled-trigger.ts, already real) whose handler calls the supplied
 * `dispatch` (wired by the caller to the live ToolRegistry's
 * registry.execute(toolName, toolArgs)). Returns the handlers keyed by
 * automation id too, so a caller (or a test) can fire one manually
 * without waiting on real wall-clock cron timing -- same "real seam,
 * testable without waiting" pattern the rest of this codebase uses.
 */
export type AutomationDispatch = (userId: string, toolName: string, toolArgs: Record<string, unknown>) => Promise<unknown>;

export function wireScheduledAutomations(db: DaveDatabase, userId: string, dispatch: AutomationDispatch): Map<string, () => Promise<unknown>> {
  const handlers = new Map<string, () => Promise<unknown>>();
  const automations = listAutomations(db, userId).filter((a): a is Automation & { cronExpression: string } => a.enabled && a.triggerType === "scheduled" && !!a.cronExpression);

  for (const automation of automations) {
    const handler = () => dispatch(automation.userId, automation.toolName, automation.toolArgs);
    handlers.set(automation.id, handler);
    unregisterScheduledTrigger(automation.id); // idempotent re-wire (e.g. registry rebuilt) -- never double-register the same id
    registerScheduledTrigger(automation.id, automation.cronExpression, async () => {
      await handler();
    });
  }
  return handlers;
}
