import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Real gap fixed (user, live: after seeing several settings change without any tool call it
 * remembered making, Dave treated its own confusion as evidence of a compromised account and
 * repeatedly halted trading over it -- "who gave it the permission to halt"). The user's own
 * fix: "add like a logs so any settings change the bot have a logs of it so it can check logs."
 * A real, durable, append-only record of every settings change this account has made -- so
 * "this looks different than before" has a genuine answer ("yes, changed at 14:02, here's the
 * before/after") instead of the model inventing a security narrative to fill the gap.
 */
export interface SettingsLogEntry {
  ts: number;
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

function logPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "settings-log.jsonl");
}

/** Appends one real settings-change record. Never throws on a logging failure -- a settings
 *  change that already genuinely happened must never be rolled back or blocked by a log write. */
export function appendSettingsLogEntry(userId: string, field: string, oldValue: unknown, newValue: unknown): void {
  try {
    const path = logPath(userId);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(path, `${JSON.stringify({ ts: Date.now(), field, oldValue, newValue })}\n`, "utf8");
  } catch {
    // Logging is best-effort -- never block a real settings change over a log write failure.
  }
}

/** Real log read, most recent first, capped at `limit` (default 50) entries. */
export function getSettingsLog(userId: string, limit = 50): SettingsLogEntry[] {
  const path = logPath(userId);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const entries: SettingsLogEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as SettingsLogEntry);
    } catch {
      // A single truncated/corrupted line must never make the whole log unreadable.
    }
  }
  return entries.reverse().slice(0, limit);
}
