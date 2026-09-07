import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Update 7: "if a worker realizes mid-task it needs a tool Dave didn't
 * give it, the worker can ASK Dave for that specific tool -- real
 * request/grant exchange (worker requests -> Dave decides grant/deny
 * -> worker's tool access updates live if granted), not the worker
 * being stuck or Dave guessing upfront." Same file-based-registry
 * pattern as worker-factory.ts's own worker registry.
 */

export type ToolRequestStatus = "pending" | "granted" | "denied";

export interface ToolRequest {
  id: string;
  workerId: string;
  toolName: string;
  reason: string;
  status: ToolRequestStatus;
  createdAt: number;
  decidedAt: number | null;
}

function requestsPath(ownerUserId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "workers", ownerUserId, "tool-requests.json");
}

function readRequests(ownerUserId: string): ToolRequest[] {
  const path = requestsPath(ownerUserId);
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveRequests(ownerUserId: string, requests: ToolRequest[]): void {
  const path = requestsPath(ownerUserId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(requests, null, 2), "utf8");
}

/** Worker-side: a real request, not a silent block or a guess. */
export function requestTool(ownerUserId: string, workerId: string, toolName: string, reason: string): ToolRequest {
  const requests = readRequests(ownerUserId);
  const request: ToolRequest = {
    id: randomBytes(6).toString("hex"),
    workerId,
    toolName,
    reason,
    status: "pending",
    createdAt: Date.now(),
    decidedAt: null,
  };
  requests.push(request);
  saveRequests(ownerUserId, requests);
  return request;
}

export function listPendingToolRequests(ownerUserId: string): ToolRequest[] {
  return readRequests(ownerUserId).filter((r) => r.status === "pending");
}

export function listToolRequestsForWorker(ownerUserId: string, workerId: string): ToolRequest[] {
  return readRequests(ownerUserId).filter((r) => r.workerId === workerId);
}

export class ToolRequestNotFoundError extends Error {
  constructor(id: string) {
    super(`No tool request "${id}" found.`);
    this.name = "ToolRequestNotFoundError";
  }
}

/** Dave-side: the real decision. Idempotent re-decision is refused -- a decision is final. */
export function decideToolRequest(ownerUserId: string, requestId: string, granted: boolean): ToolRequest {
  const requests = readRequests(ownerUserId);
  const request = requests.find((r) => r.id === requestId);
  if (!request) throw new ToolRequestNotFoundError(requestId);
  if (request.status !== "pending") {
    throw new Error(`Tool request "${requestId}" was already decided (${request.status}) -- a decision is final.`);
  }
  request.status = granted ? "granted" : "denied";
  request.decidedAt = Date.now();
  saveRequests(ownerUserId, requests);
  return request;
}

/**
 * Real, LIVE grant lookup -- reads the current file state on every
 * call, so a grant takes effect on the worker's very next tool-access
 * check, no restart/cache-invalidation step needed.
 */
export function getGrantedToolNames(ownerUserId: string, workerId: string): string[] {
  return readRequests(ownerUserId)
    .filter((r) => r.workerId === workerId && r.status === "granted")
    .map((r) => r.toolName);
}
