import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Real gap fixed (user: "if a new request comes in while Dave is busy with something else,
 * Dave doesn't just silently switch or silently ignore it"). This is the "is Dave currently
 * busy" half -- set right before a real agent-loop run starts, cleared when it finishes
 * (success or failure), same file-backed per-owner state pattern as ask-user.ts's pending
 * question.
 */
export interface BusyState {
  taskDescription: string;
  startedAt: number;
}

function busyPath(userId: string): string {
  return join(process.cwd(), "data", "agent-loop", userId, "busy.json");
}

export function setBusy(userId: string, taskDescription: string): void {
  const path = busyPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const state: BusyState = { taskDescription, startedAt: Date.now() };
  writeFileSync(path, JSON.stringify(state), "utf8");
}

export function clearBusy(userId: string): void {
  const path = busyPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(null), "utf8");
}

export function getBusyState(userId: string): BusyState | null {
  const path = busyPath(userId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}
