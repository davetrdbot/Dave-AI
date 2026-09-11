import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Same next-message-IS-the-value capture pattern as pending-trailing-entry.ts, for the
 *  confidence-threshold number typed after tapping "Set threshold" in /settings. */
function pendingPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "pending-confidence-entry.json");
}

export function setPendingConfidenceEntry(userId: string, active: boolean): void {
  const path = pendingPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(active), "utf8");
}

export function getPendingConfidenceEntry(userId: string): boolean {
  const path = pendingPath(userId);
  if (!existsSync(path)) return false;
  return JSON.parse(readFileSync(path, "utf8"));
}
