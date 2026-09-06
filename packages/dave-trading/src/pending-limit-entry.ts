import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Real gap fixed (spec: "Max open trades / Max daily loss: optional, PROTECTED (changing
 * needs fresh approval)" -- these existed as a real, tested backend (proposeProtectedLimitChange)
 * but /settings never exposed a way to actually propose a new value from Telegram, since a
 * button tap can't supply an arbitrary number. Same next-message-IS-the-value capture pattern
 * as manual model/voice/key entry, file-backed to match risk-settings.ts's own storage style. */
export type ProtectedLimitField = "maxOpenTrades" | "maxDailyLossPct";

function pendingPath(userId: string): string {
  return join(process.cwd(), "data", "trading", userId, "pending-limit-entry.json");
}

export function setPendingLimitEntry(userId: string, field: ProtectedLimitField | null): void {
  const path = pendingPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(field), "utf8");
}

export function getPendingLimitEntry(userId: string): ProtectedLimitField | null {
  const path = pendingPath(userId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}
