/**
 * Real bug fixed (user, live: a turn got stuck "thinking"/"typing" forever, burning real API
 * credit -- changing the AI Response Timeout setting, `/stop`, and `/reset` all did nothing).
 * Root cause: nothing anywhere held a reference to an in-flight turn that a command could act on
 * -- `/stop`/`/reset` only ever flipped stored flags nothing in a running `AgentLoop.run()` call
 * ever checked. This is that real, wired cancel path: an in-memory set of AbortControllers per
 * user, live only for the duration of each of their current turns, in-memory (a turn only exists
 * in-flight in this same process, so there is nothing to persist across a restart -- a crashed
 * process taking its in-flight controllers with it is the correct behavior, not a gap).
 *
 * A single user can genuinely have MORE THAN ONE turn in flight at once (their own chat message,
 * a delegated worker task, an autonomous tick's Journal consult -- all keyed by the same userId).
 * An earlier version of this module tracked exactly one AbortController per userId and
 * defensively `.abort()`-ed whatever was already there before starting a new turn ("replace any
 * stale leftover") -- that is a real race: it would wrongly kill a still-running concurrent turn
 * that was never actually stale. Tracking a Set per user instead means beginTurn() never touches
 * any other controller already tracked for that user, and abortTurn() (e.g. `/stop`) aborts
 * EVERYTHING running for that user, which is also the more correct behavior for a panic-stop.
 */
/** Where a turn came from. A new message on one chat channel cancels background work and that
 *  channel's own turn, but never the OTHER channel's reply mid-way (the app and Telegram share one
 *  conversation, and one shouldn't silently kill the other). `/stop` still stops everything. */
export type TurnChannel = "telegram" | "app" | "background";

const controllers = new Map<string, Set<AbortController>>();
const channelOf = new WeakMap<AbortController, TurnChannel>();

/** Starts tracking a new in-flight turn for this user. Creates a brand-new controller and adds it
 *  to this user's set of in-flight turns -- never touches any other controller already tracked
 *  for this user, so a genuinely concurrent turn (worker task, autonomous tick, ...) is left
 *  running untouched. */
export function beginTurn(userId: string, channel: TurnChannel = "background"): AbortController {
  const controller = new AbortController();
  channelOf.set(controller, channel);
  let set = controllers.get(userId);
  if (!set) {
    set = new Set();
    controllers.set(userId, set);
  }
  set.add(controller);
  return controller;
}

/** Stops tracking one turn once it's done (success, error, or aborted) -- removes only this
 *  specific controller from the user's set (other genuinely concurrent turns for the same user
 *  are left tracked), deleting the map entry entirely once the set becomes empty. */
export function endTurn(userId: string, controller: AbortController): void {
  const set = controllers.get(userId);
  if (!set) return;
  set.delete(controller);
  if (set.size === 0) controllers.delete(userId);
}

/** Real cancel: aborts EVERY in-flight turn for this user (their chat message, any delegated
 *  worker task, any autonomous tick consult -- all of it), which is the correct behavior for a
 *  genuine `/stop`/`/panic`. Returns whether there was at least one controller to cancel --
 *  callers use this to tell the user whether anything was actually stopped, rather than always
 *  claiming success. */
export function abortTurn(userId: string, opts: { except?: TurnChannel } = {}): boolean {
  const set = controllers.get(userId);
  if (!set || set.size === 0) return false;
  let any = false;
  for (const controller of set) {
    if (opts.except && channelOf.get(controller) === opts.except) continue;
    controller.abort();
    any = true;
  }
  return any;
}

/** Whether a turn from this channel is running right now. */
export function isTurnRunning(userId: string, channel: TurnChannel): boolean {
  for (const c of controllers.get(userId) ?? []) if (channelOf.get(c) === channel && !c.signal.aborted) return true;
  return false;
}
