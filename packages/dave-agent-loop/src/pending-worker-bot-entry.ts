import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The capture half of /settings -> Worker Bots -> "Add token" -- same next-message-IS-the-value
 * pattern as every other credential capture in this file (pending-*-entry.ts). Stores which
 * specialist (by index into WORKER_BOT_SPECIALISTS) is awaiting its token.
 */
function pendingPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "pending-worker-bot-entry.json");
}

export function setPendingWorkerBotEntry(userId: string, specialistIndex: number | null): void {
  const path = pendingPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(specialistIndex), "utf8");
}

export function getPendingWorkerBotEntry(userId: string): number | null {
  const path = pendingPath(userId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}
