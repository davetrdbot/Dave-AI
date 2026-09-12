/**
 * Real bug fixed (user, live: a turn got stuck "thinking"/"typing" forever, burning real API
 * credit -- changing the AI Response Timeout setting, `/stop`, and `/reset` all did nothing).
 * Root cause: nothing anywhere held a reference to an in-flight turn that a command could act on
 * -- `/stop`/`/reset` only ever flipped stored flags nothing in a running `AgentLoop.run()` call
 * ever checked. This is that real, wired cancel path: one `AbortController` per user, live only
 * for the duration of their current turn, in-memory (a turn only exists in-flight in this same
 * process, so there is nothing to persist across a restart -- a crashed process taking its
 * in-flight controller with it is the correct behavior, not a gap).
 */
const controllers = new Map<string, AbortController>();

/** Starts tracking a new in-flight turn for this user. Aborts and replaces any stale leftover
 *  controller first (defensive -- a previous turn should always have called endTurn, but this
 *  guarantees a fresh, not-already-aborted signal for the turn about to start). */
export function beginTurn(userId: string): AbortController {
  controllers.get(userId)?.abort();
  const controller = new AbortController();
  controllers.set(userId, controller);
  return controller;
}

/** Stops tracking a turn once it's done (success, error, or aborted) -- only clears the entry if
 *  it's still the SAME controller (a newer turn may have already replaced it). */
export function endTurn(userId: string, controller: AbortController): void {
  if (controllers.get(userId) === controller) controllers.delete(userId);
}

/** Real cancel: aborts the user's in-flight turn, if any. Returns whether there genuinely was one
 *  to cancel -- callers (e.g. `/stop`) use this to tell the user whether anything was actually
 *  stopped, rather than always claiming success. */
export function abortTurn(userId: string): boolean {
  const controller = controllers.get(userId);
  if (!controller) return false;
  controller.abort();
  return true;
}
