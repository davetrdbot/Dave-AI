import { registerScheduledTrigger, unregisterScheduledTrigger, type ScheduledTrigger } from "@dave/db";
import { createWorker, retireWorker, type Worker } from "@dave/workers";

/**
 * Step 19.3: security check cron, default Sunday, customizable, run
 * through a real worker -- same real lifecycle as Step 18.1's dreaming
 * cron (create a real worker for the run, retire it immediately after),
 * not a second, differently-shaped mechanism for what's structurally
 * the same requirement.
 */

export const DEFAULT_SECURITY_CHECK_CRON = "0 2 * * 0"; // Sunday 02:00 UTC -- ahead of the dreaming/export crons

export function registerSecurityCheckCron(
  ownerUserId: string,
  onCheck: (worker: Worker) => void | Promise<void>,
  cronExpression: string = DEFAULT_SECURITY_CHECK_CRON
): ScheduledTrigger {
  return registerScheduledTrigger(`security-check-${ownerUserId}`, cronExpression, async () => {
    const worker = createWorker(ownerUserId, { assignment: "temporary", role: "generic", task: "Weekly security check" });
    try {
      await onCheck(worker);
    } finally {
      retireWorker(ownerUserId, worker.id);
    }
  });
}

export function unregisterSecurityCheckCron(ownerUserId: string): void {
  unregisterScheduledTrigger(`security-check-${ownerUserId}`);
}
