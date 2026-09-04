import { getOrCreateWorkerWebhook, readInbox } from "@dave/memory";
import type { Worker } from "./worker-factory.js";

/**
 * Step 12.6: report_to_user tool -- a worker's direct channel for
 * updates, tagged with its own name (e.g. "#martins"), real per-worker
 * endpoint (Step 12.3), not a generic shared channel.
 */
export interface ReportToUserResult {
  ok: boolean;
  tag: string;
}

export async function reportToUser(worker: Worker, content: string, baseUrl: string): Promise<ReportToUserResult> {
  const hook = getOrCreateWorkerWebhook(worker.ownerUserId, worker.id, `#${worker.name.toLowerCase()}`);
  const res = await fetch(`${baseUrl}${hook.path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  const json = await res.json();
  return { ok: res.ok, tag: json.tag ?? hook.tag };
}

/** Convenience for reading back what a worker (or all workers) reported to a user -- tagged output. */
export function readWorkerReports(ownerUserId: string, workerId?: string) {
  return readInbox(ownerUserId)
    .filter((p) => p.type === "worker-report")
    .filter((p) => !workerId || (p.payload as { workerId: string }).workerId === workerId);
}
