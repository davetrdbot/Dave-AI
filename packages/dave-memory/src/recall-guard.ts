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

/** Call this after actually pulling memory (frozen snapshot, tier search, etc.) for a task. */
export function markRecalled(actorId: string, taskId: string, summary: string): void {
  if (!recalls.has(actorId)) recalls.set(actorId, new Map());
  recalls.get(actorId)!.set(taskId, { recalledAt: Date.now(), summary });
}

export function hasRecalled(actorId: string, taskId: string): boolean {
  return recalls.get(actorId)?.has(taskId) ?? false;
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
