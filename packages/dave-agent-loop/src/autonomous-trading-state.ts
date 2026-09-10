import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Real bug fixed (user, live: "check I don't think the worker is working... it's not analyzing
 * any [expletive] thing" -- reported minutes after a fresh deploy). Root cause confirmed:
 * `startAutonomousTradingLoop`'s `setInterval` (trading-loop.ts) and dave-safety's
 * `tradingLoop` state (interrupts.ts, explicitly documented as "nothing here needs to survive a
 * restart") are BOTH purely in-memory. Every deploy/restart is a fresh Node process, so a real,
 * live autonomous trading run the user had going gets silently killed on every single deploy --
 * with no resume, no notification, nothing -- and the user has to notice the silence and manually
 * re-send /start_trading. This is the missing, genuinely persisted half: whether the user WANTS
 * autonomous trading on survives a restart, even though the interrupt/halt machinery correctly
 * doesn't need to (that's about the current process's live state, not the user's standing intent).
 */
function statePath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "autonomous-trading-enabled.json");
}

export function setAutonomousTradingEnabled(userId: string, enabled: boolean): void {
  const path = statePath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(enabled), "utf8");
}

export function isAutonomousTradingEnabled(userId: string): boolean {
  const path = statePath(userId);
  if (!existsSync(path)) return false;
  return JSON.parse(readFileSync(path, "utf8")) === true;
}
