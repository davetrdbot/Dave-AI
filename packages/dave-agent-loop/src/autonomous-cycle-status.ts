import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Real gap fixed (traced via a dedicated investigation subagent, the trader's "why isn't it
 * trading" report): telegram-bot-server.ts's own `logCycle` already had a comment admitting "the
 * user has no other way to see why the bot isn't placing trades than this stdout trace" -- every
 * gate (EA disconnected, circuit breaker tripped, drawdown paused, a pending question blocking it,
 * busy-state, a plain model SKIP) only ever reached a server-side console.log line, invisible to
 * the trader without pulling Railway's own log tail. This is the real, small, persisted fix: the
 * SAME reason string `logCycle` already logs is now also written here, so anything that can read
 * this file (the admin panel's Autonomous Trading card, or a future Telegram status command) can
 * show the real, current answer to "why isn't it trading right now" without digging through logs.
 */

export interface CycleOutcome {
  ts: number;
  reason: string;
}

function statusPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "agent-loop", userId, "last-cycle-outcome.json");
}

export function recordCycleOutcome(userId: string, reason: string): void {
  const path = statusPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify({ ts: Date.now(), reason } satisfies CycleOutcome), "utf8");
}

export function getLastCycleOutcome(userId: string): CycleOutcome | null {
  const path = statusPath(userId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}
