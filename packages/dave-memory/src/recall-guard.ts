/**
 * Step 4.5: recall-before-acting. An explicit, enforced step in the
 * agent loop before any non-trivial task -- for both Dave and every
 * worker. This is a guard, not a suggestion: executeTask() throws if
 * recall wasn't performed for that exact task first.
 */

export class RecallRequiredError extends Error {
  constructor(actorId: string, taskId: string) {
    super(`${actorId} attempted task "${taskId}" without recalling memory first -- recall-before-acting was not satisfied.`);
    this.name = "RecallRequiredError";
  }
}

interface RecallRecord {
  recalledAt: number;
  summary: string;
}

// actorId (Dave's userId, or a worker's id) -> taskId -> recall record.
// In-memory is correct here: this guards a single in-flight agent loop's
// next action, not something that needs to survive a process restart.
const recalls = new Map<string, Map<string, RecallRecord>>();

/**
 * How long a recall stays valid. Real bug this fixes: taskIds are
 * caller-chosen strings (this module's own tests, and the Step 4 proof
 * test, both use plain reusable strings like "check-account-balance"),
 * not guaranteed-unique per invocation. Without a TTL, a recall from an
 * hour ago would silently satisfy a brand-new call to executeTask() with
 * the same taskId string, defeating the entire point of "recall BEFORE
 * acting" -- it would really mean "recalled at some point, maybe long ago."
 */
export const RECALL_TTL_MS = 5 * 60 * 1000;

/** Call this after actually pulling memory (frozen snapshot, tier search, etc.) for a task. */
export function markRecalled(actorId: string, taskId: string, summary: string): void {
  if (!recalls.has(actorId)) recalls.set(actorId, new Map());
  recalls.get(actorId)!.set(taskId, { recalledAt: Date.now(), summary });
}

export function hasRecalled(actorId: string, taskId: string): boolean {
  const record = recalls.get(actorId)?.get(taskId);
  if (!record) return false;
  if (Date.now() - record.recalledAt > RECALL_TTL_MS) {
    recalls.get(actorId)?.delete(taskId); // expired -- stop treating it as satisfied
    return false;
  }
  return true;
}

/**
 * Wraps execution of a non-trivial task. Throws RecallRequiredError if
 * markRecalled() wasn't called for this exact (actorId, taskId) pair
 * first. This is what makes recall-before-acting enforced rather than
 * merely documented.
 */
export function executeTask<T>(actorId: string, taskId: string, fn: () => T): T {
  if (!hasRecalled(actorId, taskId)) {
    throw new RecallRequiredError(actorId, taskId);
  }
  return fn();
}

/** Clears a recall record once its task is done, so the same taskId can be reused later honestly. */
export function clearRecall(actorId: string, taskId: string): void {
  recalls.get(actorId)?.delete(taskId);
}
