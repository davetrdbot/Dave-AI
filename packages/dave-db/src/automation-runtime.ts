import type { DaveDatabase, EntityEvent } from "./database.js";
import { listAutomations, setAutomationEnabled, type Automation } from "./automation-store.js";
import { registerScheduledTrigger, unregisterScheduledTrigger } from "./scheduled-trigger.js";
import { registerWebhookTrigger, unregisterWebhookTrigger, type AutomationWebhook } from "./webhook-trigger.js";

/**
 * Real bug found via live Railway logs (user: "all the providers don't work again"): a stale
 * automation whose `toolName` no longer resolves to any real registered tool (e.g. "tg_send_message"
 * -- never a real tool name, likely mis-guessed by the model when the automation was created,
 * before create_automation validated names) fired every single cron tick FOREVER, throwing the
 * same UnknownToolError over and over with nothing ever stopping it. `dispatch` failures are
 * genuinely unpredictable (a real provider outage should NOT permanently disable an automation),
 * but "the tool this automation calls does not exist and never will resolve on its own" is a
 * different, permanent kind of failure -- this self-heals it by auto-pausing the automation the
 * first time that specific, structural error is seen, rather than erroring forever.
 */
function isUnknownToolError(err: unknown): boolean {
  return err instanceof Error && err.name === "UnknownToolError";
}

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
  const all = listAutomations(db, userId);
  const active = all.filter((a): a is Automation & { cronExpression: string } => a.enabled && a.triggerType === "scheduled" && !!a.cronExpression);
  const activeIds = new Set(active.map((a) => a.id));

  // Real gap fixed (user: "every 3 minutes send me hi never fired"): this function is the ONLY
  // place a scheduled automation's real node-cron trigger ever gets registered, and it was only
  // ever called once, at registry-BUILD time (buildFullToolRegistry(), itself only built once
  // per chat and cached for the process's lifetime). create_automation/pause_automation/
  // resume_automation/delete_automation all just wrote a DB row -- none of them re-ran this, so
  // an automation created (or paused/resumed) after the registry's first build had zero live
  // effect until a full process restart happened to rebuild it. Fixed at both ends: this
  // function is now also called from automation-tools.ts's `resync` callback right after every
  // create/pause/resume, so it takes effect immediately; and it now ALSO tears down any
  // previously-registered trigger for an automation that still exists as a DB row but is no
  // longer active (paused, or switched away from "scheduled") -- previously re-wiring only ever
  // ADDED/replaced triggers, so a paused automation kept firing on its old schedule forever.
  for (const automation of all) {
    if (!activeIds.has(automation.id)) unregisterScheduledTrigger(automation.id);
  }

  for (const automation of active) {
    const handler = () => dispatch(automation.userId, automation.toolName, automation.toolArgs);
    handlers.set(automation.id, handler);
    unregisterScheduledTrigger(automation.id); // idempotent re-wire (e.g. registry rebuilt) -- never double-register the same id
    registerScheduledTrigger(automation.id, automation.cronExpression, async () => {
      try {
        await handler();
      } catch (err) {
        if (isUnknownToolError(err)) {
          console.error(`[automation-runtime] "${automation.name}" (${automation.id}) calls tool "${automation.toolName}", which does not exist -- auto-pausing it instead of erroring on every future tick.`);
          setAutomationEnabled(db, automation.userId, automation.id, false);
          unregisterScheduledTrigger(automation.id);
          return;
        }
        throw err;
      }
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
  const all = listAutomations(db, userId);
  const automations = all.filter((a): a is Automation & { webhookToken: string } => a.enabled && a.triggerType === "webhook" && !!a.webhookToken);

  // Same real gap as wireScheduledAutomations above -- a paused webhook automation must stop
  // accepting real POSTs, not just be filtered out of future re-wires while the old route stays live.
  const activeTokens = new Set(automations.map((a) => a.webhookToken));
  for (const automation of all) {
    if (automation.webhookToken && !activeTokens.has(automation.webhookToken)) unregisterWebhookTrigger(automation.webhookToken);
  }

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
    if (automations.length === 0) return;
    // Real bug fixed (bug-hunt pass on a live trading bot), two distinct problems in one line.
    //
    // 1. `void dispatch(...)` had no .catch(). dispatch executes a real agent tool (LLM, broker,
    //    DB, network), so it genuinely rejects -- an unhandled rejection, which Node turns into a
    //    process-killing uncaught exception. A failing automation also reported to nobody at all,
    //    not even a console line.
    // 2. Worse, this fanned out with NO bound: one db.insert() on a watched table fired every
    //    matching automation simultaneously. On the single Node process that also serves the EA
    //    webhook (every 8 seconds), the Telegram webhook and every LLM call, a burst of inserts
    //    -- trade rows arriving from an EA tick, exactly the hot path here -- became N x M
    //    concurrent tool executions and starved the trading loop.
    //
    // Run sequentially instead: automations are background work and have no reason to race the
    // live trading loop for the event loop. Each failure is isolated, so one broken automation
    // never stops the rest.
    void (async () => {
      for (const automation of automations) {
        try {
          await dispatch(automation.userId, automation.toolName, { ...automation.toolArgs, entityEvent: event });
        } catch (err) {
          console.error(`[automation] entity automation "${automation.toolName}" failed for ${automation.userId}:`, err);
        }
      }
    })();
  });
  entitySubscriptions.set(userId, unsubscribe);
  return unsubscribe;
}
