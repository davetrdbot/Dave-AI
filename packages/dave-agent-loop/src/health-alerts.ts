import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Real bug class fixed (the trader, live: "find bugs this bot" -- five separate failure modes all
 * shared one root problem). Dave already DETECTED every one of these: the EA going offline
 * (telegram-bot-server.ts's own `!eaStatus.connected` gate), the autonomous cycle throwing
 * (trading-loop.ts's `.catch`), the bot process hanging (main.ts's real forked watchdog), the EA
 * coming back (ea-webhook.ts's isNewConnection), and a manual SL/TP edit in MT5
 * (manual-modify-detector.ts). Every single one of them then dead-ended at a console.log/
 * console.error on a Railway server nobody watches -- main.ts's watchdog handler even carried a
 * comment describing a "best-effort alert" that was never actually written. For a bot trading real
 * money the consequence is the worst possible failure shape: it stops trading, looks fine, and the
 * owner finds out hours later.
 *
 * Everything here is EDGE-triggered, never level-triggered -- deliberately, because the same
 * trader had just reported the bot "disturbing" him. A condition that stays true (EA still
 * offline, cycle still failing the same way) must notify ONCE, not once per cycle. State lives in
 * a real file per owner so it survives the restarts that are themselves one of the failure modes.
 */

export interface HealthAlertState {
  /** Last connection state the owner was actually TOLD about -- not the live state. */
  notifiedEaConnected?: boolean;
  /** Fingerprint of the last cycle error the owner was told about, + when. */
  lastCycleErrorKey?: string;
  lastCycleErrorAt?: number;
}

function statePath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "agent-loop", userId, "health-alerts.json");
}

function readState(userId: string): HealthAlertState {
  const path = statePath(userId);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as HealthAlertState;
  } catch {
    // A corrupt state file must never take the bot's own alerting down with it -- worst case this
    // re-sends one alert, which is strictly better than throwing inside a health check.
    return {};
  }
}

function writeState(userId: string, state: HealthAlertState): void {
  const path = statePath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(state), "utf8");
}

/**
 * Returns the message to send about an EA connection-state change, or null if the owner has
 * already been told about this exact state. The FIRST observation of a healthy connection is
 * recorded silently -- a freshly-booted bot that finds the EA already connected has no news.
 */
export function eaConnectionAlert(userId: string, connected: boolean, secondsSinceLastSeen: number | null): string | null {
  const state = readState(userId);
  if (state.notifiedEaConnected === connected) return null;
  const firstObservation = state.notifiedEaConnected === undefined;
  writeState(userId, { ...state, notifiedEaConnected: connected });
  if (connected) return firstObservation ? null : "🟢 MT5 is back online -- I'm hunting again.";
  const lastSeen = secondsSinceLastSeen === null ? "" : ` Last seen ${formatAge(secondsSinceLastSeen)} ago.`;
  return `🔴 I've lost MT5 -- no live data, so I've stopped hunting until it's back.${lastSeen}\n\nCheck that MetaTrader is running, the chart still has the Dave EA attached, and the PC hasn't slept.`;
}

function formatAge(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

/** Re-alert about an ONGOING identical failure at most this often -- so a permanently broken
 *  provider key reminds the owner occasionally instead of either spamming or going silent forever. */
const CYCLE_ERROR_REPEAT_MS = 60 * 60 * 1000;

/**
 * Returns the message to send about a thrown autonomous cycle, or null if this same failure was
 * already reported recently. Keyed on the error's own shape, so a genuinely NEW failure always
 * gets through immediately even inside the repeat window.
 */
export function cycleErrorAlert(userId: string, err: unknown, now = Date.now()): string | null {
  const raw = err instanceof Error ? err.message : String(err);
  // Numbers (ids, timestamps, ticket numbers) would make every occurrence look unique and defeat
  // the dedup entirely -- the shape of the failure is what identifies it, not its instance.
  const key = raw.replace(/\d+/g, "#").slice(0, 200);
  const state = readState(userId);
  const sameAsLast = state.lastCycleErrorKey === key;
  const withinWindow = state.lastCycleErrorAt !== undefined && now - state.lastCycleErrorAt < CYCLE_ERROR_REPEAT_MS;
  if (sameAsLast && withinWindow) return null;
  writeState(userId, { ...state, lastCycleErrorKey: key, lastCycleErrorAt: now });
  const repeated = sameAsLast ? " (still happening)" : "";
  return `⚠️ My trading cycle is crashing${repeated} -- I'm not placing any trades until this clears.\n\n${raw.slice(0, 500)}`;
}

/** Clears the cycle-error memory once a cycle genuinely completes, so the NEXT failure (even the
 *  same one) is reported immediately rather than being swallowed by a stale repeat window. */
export function clearCycleErrorAlert(userId: string): void {
  const state = readState(userId);
  if (state.lastCycleErrorKey === undefined && state.lastCycleErrorAt === undefined) return;
  writeState(userId, { ...state, lastCycleErrorKey: undefined, lastCycleErrorAt: undefined });
}
