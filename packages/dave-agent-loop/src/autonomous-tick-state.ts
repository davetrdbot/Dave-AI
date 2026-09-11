import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Real, small, bounded continuity for the autonomous tick -- modeled directly on the user's own
 * former bot's `recentContext()`/`auto_trade_state` pattern (`auto-trade-tick/index.ts`), not on
 * a growing chat transcript. A rolling window of the last 3 real decisions plus per-symbol
 * cooldown timestamps and a hunt-mode skip counter -- all file-backed, per user, same pattern as
 * every other per-user store in this codebase.
 */

export interface TickDecisionRecord {
  ts: number;
  symbol: string;
  action: "BUY" | "SELL" | "SKIP" | "ASK";
  reason: string;
}

export interface TickState {
  recentDecisions: TickDecisionRecord[];
  /** symbol -> timestamp of the last real trade-affecting decision on it */
  cooldownUntil: Record<string, number>;
  huntSkipCount: number;
  huntLastSymbol: string | null;
}

const DEFAULT_STATE: TickState = { recentDecisions: [], cooldownUntil: {}, huntSkipCount: 0, huntLastSymbol: null };
const MAX_RECENT = 3;

function statePath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "agent-loop", userId, "autonomous-tick-state.json");
}

export function getTickState(userId: string): TickState {
  const path = statePath(userId);
  if (!existsSync(path)) return { ...DEFAULT_STATE, cooldownUntil: {} };
  return { ...DEFAULT_STATE, ...JSON.parse(readFileSync(path, "utf8")) };
}

function saveTickState(userId: string, state: TickState): void {
  const path = statePath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(state), "utf8");
}

/** Real rolling window -- keeps only the last MAX_RECENT decisions, oldest dropped first. */
export function recordTickDecision(userId: string, record: TickDecisionRecord): void {
  const state = getTickState(userId);
  state.recentDecisions = [...state.recentDecisions, record].slice(-MAX_RECENT);
  saveTickState(userId, state);
}

/** Formats the real rolling decisions as short context text for the next tick's prompt --
 *  bounded, always fresh, never a growing transcript. Empty string when there's nothing yet. */
export function formatRecentDecisions(userId: string): string {
  const { recentDecisions } = getTickState(userId);
  if (recentDecisions.length === 0) return "";
  const lines = recentDecisions.map((d) => `- ${d.symbol} ${d.action}: ${d.reason}`);
  return `\nRECENT DECISIONS (last ${recentDecisions.length}):\n${lines.join("\n")}`;
}

const COOLDOWN_MS = 90_000; // 90s, same real cooldown the reference bot uses to avoid re-signaling the same symbol too fast

export function isOnCooldown(userId: string, symbol: string, now = Date.now()): boolean {
  const state = getTickState(userId);
  const until = state.cooldownUntil[symbol];
  return typeof until === "number" && now < until;
}

export function setCooldown(userId: string, symbol: string, now = Date.now()): void {
  const state = getTickState(userId);
  state.cooldownUntil = { ...state.cooldownUntil, [symbol]: now + COOLDOWN_MS };
  saveTickState(userId, state);
}

/** Real hunt-mode gating: only broadens beyond the primary scan after HUNT_THRESHOLD consecutive
 *  skips on the same symbol -- not every single cycle regardless. Returns the new count. */
export const HUNT_THRESHOLD = 3;

export function recordSkipForHunt(userId: string, symbol: string): number {
  const state = getTickState(userId);
  const sameSymbol = state.huntLastSymbol === symbol;
  state.huntSkipCount = sameSymbol ? state.huntSkipCount + 1 : 1;
  state.huntLastSymbol = symbol;
  saveTickState(userId, state);
  return state.huntSkipCount;
}

export function clearHuntState(userId: string): void {
  const state = getTickState(userId);
  state.huntSkipCount = 0;
  state.huntLastSymbol = null;
  saveTickState(userId, state);
}
