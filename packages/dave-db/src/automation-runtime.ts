import type { DaveDatabase, EntityEvent } from "./database.js";
import { listAutomations, type Automation } from "./automation-store.js";
import { registerScheduledTrigger, unregisterScheduledTrigger } from "./scheduled-trigger.js";
import { registerWebhookTrigger, unregisterWebhookTrigger, type AutomationWebhook } from "./webhook-trigger.js";

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

/**
 * Real gap fixed: "webhook" automations persisted a row with no
 * connection to the real webhook-trigger primitive at all -- an
 * external POST had nothing to fire. This wires every enabled webhook
 * automation to a REAL registered route, reusing its stored token so
 * the URL stays stable across a registry rebuild/restart instead of
 * silently changing under whoever was pointed at it.
 */
export function wireWebhookAutomations(db: DaveDatabase, userId: string, dispatch: AutomationDispatch): Map<string, AutomationWebhook> {
  const routes = new Map<string, AutomationWebhook>();
  const automations = listAutomations(db, userId).filter((a): a is Automation & { webhookToken: string } => a.enabled && a.triggerType === "webhook" && !!a.webhookToken);

  for (const automation of automations) {
    const route = registerWebhookTrigger(
      automation.id,
      async () => {
        await dispatch(automation.userId, automation.toolName, automation.toolArgs);
      },
      automation.webhookToken
    );
    routes.set(automation.id, route);
  }
  return routes;
}

/**
 * Real gap fixed: "entity" automations had the same problem --
 * db.onEntityEvent() is a real, working primitive (Step 16.2b), but
 * nothing subscribed to it on behalf of a persisted entity automation.
 * Matches on the row's real table name against the automation's
 * entityName; returns the unsubscribe function so a caller can tear
 * this down on registry rebuild instead of stacking subscriptions.
 *
 * Real bug found and fixed: buildFullToolRegistry() (dave-agent-loop)
 * is built once PER CHAT, not once per owner (telegram-bot-server.ts
 * caches registries by `ownerUserId:chatId`), so this used to be
 * called again every time the SAME owner messaged from a second chat
 * -- and db.onEntityEvent() is a plain EventEmitter.on(), which stacks
 * a new listener on every call rather than replacing the old one. A
 * single real db.insert() ended up firing the automation N times (N =
 * number of registry builds for that owner), not once. Fixed the same
 * way wireScheduledAutomations already handles this: unsubscribe the
 * previous listener for this owner (if any) before subscribing again,
 * so re-wiring is genuinely idempotent.
 */
const entitySubscriptions = new Map<string, () => void>();

export function wireEntityAutomations(db: DaveDatabase, userId: string, dispatch: AutomationDispatch): () => void {
  entitySubscriptions.get(userId)?.();
  const unsubscribe = db.onEntityEvent((event: EntityEvent) => {
    if (event.ownerUserId !== userId) return;
    const automations = listAutomations(db, userId).filter((a) => a.enabled && a.triggerType === "entity" && a.entityName === event.table);
    for (const automation of automations) {
      void dispatch(automation.userId, automation.toolName, { ...automation.toolArgs, entityEvent: event });
    }
  });
  entitySubscriptions.set(userId, unsubscribe);
  return unsubscribe;
}
