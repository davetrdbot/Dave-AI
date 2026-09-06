import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
  return join(process.cwd(), "data", "trading", userId, "trading-mode.json");
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
  const p = path(userId);
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify({ mode, lockedSkillId: mode === "trading-skills" ? lockedSkillId : undefined }, null, 2), "utf8");
}

/** Item 8 (/reset "config/settings back to defaults"): deletes the file so getTradingMode's own real default ("auto") takes over. */
export function resetTradingModeForUser(userId: string): void {
  rmSync(path(userId), { force: true });
}
