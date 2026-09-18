import type { DaveDatabase } from "./database.js";

/**
 * Step 16.3: multi-step workflows (call -> wait -> branch) that can
 * pause on a condition WITHOUT POLLING, and SURVIVE RESTARTS.
 *
 * No-polling design: a "wait" step schedules exactly one `setTimeout`
 * for the remaining delay and persists the absolute resume timestamp --
 * there is no interval anywhere re-checking "is it time yet?".
 *
 * Restart-survival design: every step transition is written to the
 * `workflow_runs` table (via Step 16.1's real DaveDatabase) before the
 * engine moves on, including the absolute `next_resume_at` timestamp
 * for a waiting run. `recoverPendingRuns()` is meant to be called once
 * on process boot: it reloads every run still in "waiting" status and
 * reschedules a single timer for whatever time remains (zero if the
 * process was down past the original resume time, so it fires
 * essentially immediately) -- the run resumes from its persisted
 * `step_index`, not from the start.
 */

/**
 * `next` controls explicit control flow after a call/wait step -- it
 * defaults to the following array index, but MUST be set to "end" (or
 * jumped past the other branch's steps) when a step is the last one on
 * one arm of a branch. Without this, falling through to "index + 1"
 * after running the `ifTrue` arm would run straight into the `ifFalse`
 * arm's steps too, since both live in the same flat array -- a real bug
 * caught by this step's own test (both `notify_high` and `notify_low`
 * fired on a single run before `next` existed).
 */
export type WorkflowStep =
  | { type: "call"; name: string; next?: number | "end" }
  | { type: "wait"; ms: number; next?: number | "end" }
  | { type: "branch"; condition: string; ifTrue: number; ifFalse: number };

export type WorkflowStatus = "running" | "waiting" | "completed" | "failed";

interface WorkflowRunRow {
  id: string;
  workflow_id: string;
  steps: string;
  step_index: number;
  context: string;
  status: WorkflowStatus;
  next_resume_at: number | null;
  error: string | null;
}

export interface WorkflowRun {
  runId: string;
  workflowId: string;
  stepIndex: number;
  context: Record<string, unknown>;
  status: WorkflowStatus;
  error?: string;
}

const TABLE = "workflow_runs";

export class WorkflowEngine {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly db: DaveDatabase,
    private readonly ownerUserId: string,
    private readonly handlers: Record<string, (context: Record<string, unknown>) => Promise<unknown>>,
    private readonly conditions: Record<string, (context: Record<string, unknown>) => boolean>
  ) {
    this.db.createTable(TABLE, [
      { name: "workflow_id", type: "TEXT" },
      { name: "steps", type: "TEXT" },
      { name: "step_index", type: "INTEGER" },
      { name: "context", type: "TEXT" },
      { name: "status", type: "TEXT" },
      { name: "next_resume_at", type: "INTEGER" },
      { name: "error", type: "TEXT" },
    ]);
  }

  start(workflowId: string, steps: WorkflowStep[], initialContext: Record<string, unknown> = {}): string {
    const runId = this.db.insert(TABLE, this.ownerUserId, {
      workflow_id: workflowId,
      steps: JSON.stringify(steps),
      step_index: 0,
      context: JSON.stringify(initialContext),
      status: "running" satisfies WorkflowStatus,
      next_resume_at: null,
      error: null,
    });
    void this.advance(runId);
    return runId;
  }

  getRun(runId: string): WorkflowRun | undefined {
    const row = this.db.getById(TABLE, this.ownerUserId, runId) as WorkflowRunRow | undefined;
    if (!row) return undefined;
    return this.toRun(row);
  }

  private toRun(row: WorkflowRunRow): WorkflowRun {
    return {
      runId: row.id,
      workflowId: row.workflow_id,
      stepIndex: row.step_index,
      context: JSON.parse(row.context),
      status: row.status,
      error: row.error ?? undefined,
    };
  }

  private async advance(runId: string): Promise<void> {
    const row = this.db.getById(TABLE, this.ownerUserId, runId) as WorkflowRunRow | undefined;
    if (!row || row.status !== "running") return;

    // Real bug fixed (bug-hunt pass on a live trading bot): these two JSON.parse calls and the
    // completion write below used to sit OUTSIDE the try block. A truncated or corrupt `steps`/
    // `context` column -- entirely reachable, since this process has genuinely been crashing
    // mid-write -- threw here, escaped `advance()` as a rejected promise, and both call sites
    // invoke this as a bare `void this.advance(runId)` with no .catch(). That is an unhandled
    // rejection, which Node turns into a process-killing uncaught exception. It also left the run
    // stuck in "running" forever, with no "failed" status and nobody told. Everything that can
    // throw is now inside the try, so a corrupt run fails cleanly and visibly instead.
    let steps: WorkflowStep[];
    let context: Record<string, unknown>;
    try {
      steps = JSON.parse(row.steps);
      context = JSON.parse(row.context);
    } catch (err) {
      this.db.update(TABLE, this.ownerUserId, runId, {
        status: "failed" satisfies WorkflowStatus,
        error: `workflow run data is corrupt and cannot be read: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    if (row.step_index >= steps.length) {
      this.db.update(TABLE, this.ownerUserId, runId, { status: "completed" satisfies WorkflowStatus });
      return;
    }

    const step = steps[row.step_index];
    try {
      switch (step.type) {
        case "call": {
          const handler = this.handlers[step.name];
          if (!handler) throw new Error(`no handler registered for call step "${step.name}"`);
          const result = await handler(context);
          context[step.name] = result;
          const nextIndex = step.next === "end" ? steps.length : step.next ?? row.step_index + 1;
          this.db.update(TABLE, this.ownerUserId, runId, { step_index: nextIndex, context: JSON.stringify(context) });
          await this.advance(runId);
          break;
        }
        case "wait": {
          const resumeAt = Date.now() + step.ms;
          const nextIndex = step.next === "end" ? steps.length : step.next ?? row.step_index + 1;
          this.db.update(TABLE, this.ownerUserId, runId, { status: "waiting" satisfies WorkflowStatus, next_resume_at: resumeAt, step_index: nextIndex });
          this.scheduleResume(runId, resumeAt);
          break;
        }
        case "branch": {
          const conditionFn = this.conditions[step.condition];
          if (!conditionFn) throw new Error(`no condition registered named "${step.condition}"`);
          const nextIndex = conditionFn(context) ? step.ifTrue : step.ifFalse;
          this.db.update(TABLE, this.ownerUserId, runId, { step_index: nextIndex });
          await this.advance(runId);
          break;
        }
      }
    } catch (err) {
      this.db.update(TABLE, this.ownerUserId, runId, { status: "failed" satisfies WorkflowStatus, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private scheduleResume(runId: string, resumeAt: number): void {
    const delay = Math.max(0, resumeAt - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(runId);
      this.db.update(TABLE, this.ownerUserId, runId, { status: "running" satisfies WorkflowStatus, next_resume_at: null });
      void this.advance(runId);
    }, delay);
    this.timers.set(runId, timer);
  }

  /** Cancels every timer this engine instance owns -- what a real process exit does implicitly. */
  shutdown(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /**
   * Call once on process boot. No polling loop -- reloads every run
   * still "waiting" and reschedules exactly one timer per run, for
   * whatever time genuinely remains (0 if the process was down past
   * the original resume time).
   */
  recoverPendingRuns(): number {
    const waiting = this.db.query(TABLE, this.ownerUserId, { status: "waiting" }) as unknown as WorkflowRunRow[];
    for (const row of waiting) {
      this.scheduleResume(row.id, row.next_resume_at ?? Date.now());
    }
    return waiting.length;
  }
}
