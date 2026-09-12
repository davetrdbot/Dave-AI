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

/**
 * Real gap fixed (user, live: "/stop_trading it shouldn't give it offer to place new trade
 * because I just did it now and it's still placing trade" -- plus the user's own explicit
 * follow-up ask that /stop_trading keep watching for a genuinely sniper-tier setup instead of
 * going fully dark). Deliberately a SEPARATE persisted flag from isAutonomousTradingEnabled
 * above: that one controls whether the scheduler's loop is armed at all (survives a restart,
 * only ever turned off by a real /stop or /panic, which stay a genuine full stop with no
 * scanning). This one controls whether a NORMAL trade may auto-execute -- /stop_trading turns
 * this off without tearing down the loop, so the tick keeps running (still analyzing, still
 * showing open-position info, still able to ASK/DELETE_TICKET/PARTIAL_CLOSE) but a normal
 * decision won't auto-fire; only a genuinely sniper-tier setup gets surfaced as an approve/
 * decline ask. Defaults to true (normal execution) so a brand-new user's very first
 * /start_trading isn't silently in watch-only mode.
 */
function executionEnabledPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "autonomous-execution-enabled.json");
}

export function setAutonomousExecutionEnabled(userId: string, enabled: boolean): void {
  const path = executionEnabledPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(enabled), "utf8");
}

export function isAutonomousExecutionEnabled(userId: string): boolean {
  const path = executionEnabledPath(userId);
  if (!existsSync(path)) return true;
  return JSON.parse(readFileSync(path, "utf8")) !== false;
}
