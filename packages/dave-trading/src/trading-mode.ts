import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendSettingsLogEntry } from "./settings-log.js";

/**
 * Step 10.4: Trading mode -- Auto (own judgment + skill library) or
 * Trading Skills (locked to one taught pattern).
 */
export type TradingMode = "auto" | "trading-skills";

export interface TradingModeState {
  mode: TradingMode;
  lockedSkillId?: string; // only meaningful when mode === "trading-skills"
}

function path(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "trading-mode.json");
}

export function getTradingMode(userId: string): TradingModeState {
  const p = path(userId);
  if (!existsSync(p)) return { mode: "auto" };
  return JSON.parse(readFileSync(p, "utf8"));
}

export class TradingSkillsModeRequiresSkillError extends Error {
  constructor() {
    super('Trading mode "trading-skills" requires a specific lockedSkillId -- pick which taught pattern to lock to.');
    this.name = "TradingSkillsModeRequiresSkillError";
  }
}

export function setTradingMode(userId: string, mode: TradingMode, lockedSkillId?: string): void {
  if (mode === "trading-skills" && !lockedSkillId) {
    throw new TradingSkillsModeRequiresSkillError();
  }
  const oldState = getTradingMode(userId);
  const p = path(userId);
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify({ mode, lockedSkillId: mode === "trading-skills" ? lockedSkillId : undefined }, null, 2), "utf8");
  appendSettingsLogEntry(userId, "tradingMode", oldState.mode, mode);
}

/** Item 8 (/reset "config/settings back to defaults"): deletes the file so getTradingMode's own real default ("auto") takes over. */
export function resetTradingModeForUser(userId: string): void {
  rmSync(path(userId), { force: true });
}

/**
 * Part 2 (skill scoping): thin, clearly-named wrappers around the mode above, for the "active
 * trading strategy" concept -- a skill (from @dave/skills) marked as the one real strategy Dave
 * follows right now. Same storage, same "auto" fallback, just named for what it actually means to
 * a caller that doesn't care about the underlying mode/lockedSkillId shape. No separate file, no
 * second source of truth -- setting or clearing the active strategy IS setting the trading mode.
 */
export function getActiveStrategySkillId(userId: string): string | undefined {
  const state = getTradingMode(userId);
  return state.mode === "trading-skills" ? state.lockedSkillId : undefined;
}

export function setActiveStrategySkill(userId: string, skillId: string): void {
  setTradingMode(userId, "trading-skills", skillId);
}

export function clearActiveStrategySkill(userId: string): void {
  setTradingMode(userId, "auto");
}
