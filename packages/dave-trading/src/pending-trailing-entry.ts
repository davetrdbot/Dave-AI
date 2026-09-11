import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Real gap fixed (spec: "Trailing/breakeven... + TP1/TP2/TP3 trigger values") -- the real
 * backend (trailing-config.ts's getTrailingStopConfig/setTrailingStopConfig) already existed,
 * but nothing in /settings ever let the user actually set the 3 values from Telegram. Same
 * next-message-IS-the-value capture pattern used throughout this build. */
export type TrailingField = "slAtTp1" | "slAtTp2" | "slAtTp3";

function pendingPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "pending-trailing-entry.json");
}

export function setPendingTrailingEntry(userId: string, field: TrailingField | null): void {
  const path = pendingPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(field), "utf8");
}

export function getPendingTrailingEntry(userId: string): TrailingField | null {
  const path = pendingPath(userId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}
