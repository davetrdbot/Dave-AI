import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Item 5 real gap fixed (user: "add a real settings button letting the user configure what the
 * EA pushes in its heartbeat/state payload and at what interval"). Same next-message-IS-the-
 * value capture pattern as pending-risk-entry.ts -- tapping the /connection "Push interval"
 * button primes this; the user's next message is read as the new interval in seconds.
 */
function pendingPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "ea-bridge", userId, "pending-push-interval.json");
}

export function setPendingPushIntervalEntry(userId: string, pending: boolean): void {
  const path = pendingPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(pending), "utf8");
}

export function getPendingPushIntervalEntry(userId: string): boolean {
  const path = pendingPath(userId);
  if (!existsSync(path)) return false;
  return JSON.parse(readFileSync(path, "utf8")) === true;
}
