import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Real gap fixed (user, live: wants the bot able to pause itself for up to 5 minutes when it
 * judges exposure is already high, without going fully dark -- it should keep receiving/showing
 * open-trade info and still be able to ASK/DELETE_TICKET/PARTIAL_CLOSE while paused, just not open
 * new trades). Deliberately separate from `@dave/safety`'s `isTradingHalted`/`stopOrPanic` --
 * /stop and /panic must stay absolute and untouched by this; self-pause is enforced entirely
 * inside autonomous-tick.ts's own decision logic, never at the scheduler or the top-level halt
 * gate. File-backed, per-user, same auto-expiring pattern busy-state.ts already proved for its
 * own class of "state that must never survive past its real, bounded lifetime."
 */
export interface SelfPauseState {
  pausedUntil: number;
  reason: string;
}

export const MIN_SELF_PAUSE_MINUTES = 1;
export const MAX_SELF_PAUSE_MINUTES = 60;
/** PAUSE with no length: a quarter of an hour of rest. */
export const DEFAULT_SELF_PAUSE_MINUTES = 15;

function selfPausePath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "agent-loop", userId, "self-pause.json");
}

/** Clamps to [MIN_SELF_PAUSE_MINUTES, MAX_SELF_PAUSE_MINUTES] -- the model's own judgment call
 *  on duration, never below 1 or above an hour.
 *
 *  Self-pause is REST (the trader: "use the self pause instead of burning credits -- wake when a
 *  reminder hits"): while it runs the scan loop makes no AI calls at all (trading-loop.ts), and
 *  anything that matters -- a self-aware alert, a reminder, a marked level, a setup step -- wakes
 *  Dave at once (wakeFromSelfPause, called by alert-focus.ts and reminder-delivery.ts). The trade
 *  monitor, level watcher and reminders keep running underneath; they cost no credits. */
export function setSelfPause(userId: string, minutes: number, reason: string): SelfPauseState {
  const clamped = Math.min(MAX_SELF_PAUSE_MINUTES, Math.max(MIN_SELF_PAUSE_MINUTES, Math.round(minutes)));
  const state: SelfPauseState = { pausedUntil: Date.now() + clamped * 60_000, reason };
  const path = selfPausePath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(state), "utf8");
  return state;
}

/** Auto-expires once real time has passed `pausedUntil` -- never trusted forever, same reasoning
 *  as busy-state.ts's MAX_BUSY_AGE_MS: a pause that outlives its own stated window is not a real
 *  pause anymore, it's stale state. */
export function getSelfPause(userId: string): SelfPauseState | null {
  const path = selfPausePath(userId);
  if (!existsSync(path)) return null;
  const state = JSON.parse(readFileSync(path, "utf8")) as SelfPauseState | null;
  if (state && Date.now() > state.pausedUntil) return null;
  return state;
}

export function clearSelfPause(userId: string): void {
  const path = selfPausePath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(null), "utf8");
}

/** Ends a rest early because something needs Dave. Returns the pause that was cleared, or null. */
export function wakeFromSelfPause(userId: string): SelfPauseState | null {
  const state = getSelfPause(userId);
  if (!state) return null;
  clearSelfPause(userId);
  return state;
}
