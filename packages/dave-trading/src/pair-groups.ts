import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Step 10.5: pair selection is group-based. The GROUP SYSTEM is generic
 * -- Step 14's admin panel lets the user define which symbols go in
 * which group; this module never hardcodes group content. Exactly one
 * active group + one fallback at a time, never multiple active
 * simultaneously, no default pre-selected.
 */

export interface PairGroup {
  id: string;
  name: string;
  symbols: string[];
}

interface GroupState {
  groups: PairGroup[];
  activeGroupId: string | null;
  fallbackGroupId: string | null;
  pausedForExtremeConditions: boolean;
}

const EMPTY_STATE: GroupState = { groups: [], activeGroupId: null, fallbackGroupId: null, pausedForExtremeConditions: false };

function statePath(userId: string): string {
  return join(process.cwd(), "data", "trading", userId, "pair-groups.json");
}

function readState(userId: string): GroupState {
  const path = statePath(userId);
  if (!existsSync(path)) return { ...EMPTY_STATE, groups: [] };
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveState(userId: string, state: GroupState): void {
  const path = statePath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
}

/** Step 14's admin panel is the real UI for this -- this is the storage/logic it reads and writes. */
export function upsertGroup(userId: string, group: PairGroup): void {
  const state = readState(userId);
  const idx = state.groups.findIndex((g) => g.id === group.id);
  if (idx >= 0) state.groups[idx] = group;
  else state.groups.push(group);
  saveState(userId, state);
}

export function deleteGroup(userId: string, groupId: string): void {
  const state = readState(userId);
  state.groups = state.groups.filter((g) => g.id !== groupId);
  if (state.activeGroupId === groupId) state.activeGroupId = null;
  if (state.fallbackGroupId === groupId) state.fallbackGroupId = null;
  saveState(userId, state);
}

export function listGroups(userId: string): PairGroup[] {
  return readState(userId).groups;
}

export class UnknownGroupError extends Error {
  constructor(groupId: string) {
    super(`No pair group "${groupId}" exists -- create it first.`);
    this.name = "UnknownGroupError";
  }
}

/**
 * Sets the active group. Enforced here: activating a group implicitly
 * ensures it's the ONLY active one (there is only ever one activeGroupId
 * field -- structurally impossible to have two active groups at once,
 * not just a convention).
 */
export function setActiveGroup(userId: string, groupId: string): void {
  const state = readState(userId);
  if (!state.groups.some((g) => g.id === groupId)) throw new UnknownGroupError(groupId);
  state.activeGroupId = groupId;
  state.pausedForExtremeConditions = false;
  saveState(userId, state);
}

export function setFallbackGroup(userId: string, groupId: string): void {
  const state = readState(userId);
  if (!state.groups.some((g) => g.id === groupId)) throw new UnknownGroupError(groupId);
  state.fallbackGroupId = groupId;
  saveState(userId, state);
}

/**
 * Item 8 (/reset "config/settings back to defaults"): clears the active/fallback SELECTION only
 * -- the user's own defined groups (created in the admin panel, real authored content, not a
 * setting) are deliberately preserved, same reasoning as goal.yaml surviving a reset.
 */
export function resetPairGroupSelectionForUser(userId: string): void {
  const state = readState(userId);
  state.activeGroupId = null;
  state.fallbackGroupId = null;
  state.pausedForExtremeConditions = false;
  saveState(userId, state);
}

export interface ActiveGroupInfo {
  activeGroup: PairGroup | null;
  fallbackGroup: PairGroup | null;
  pausedForExtremeConditions: boolean;
}

export function getActiveGroupInfo(userId: string): ActiveGroupInfo {
  const state = readState(userId);
  return {
    activeGroup: state.groups.find((g) => g.id === state.activeGroupId) ?? null,
    fallbackGroup: state.groups.find((g) => g.id === state.fallbackGroupId) ?? null,
    pausedForExtremeConditions: state.pausedForExtremeConditions,
  };
}

/**
 * Step 10.6: extreme market conditions on the active group -> pause and
 * auto-switch to fallback. The caller supplies what "extreme" means for
 * this check (e.g. from a real DAVEMA /volatility or /regime read) --
 * this module only owns the switching mechanics, not the market-
 * condition judgment itself (that's analysis, not group management, and
 * per the master prompt stays out of any hardcoded trading logic here).
 */
export function handleExtremeConditions(userId: string, isExtreme: boolean): { switched: boolean; newActiveGroupId: string | null } {
  if (!isExtreme) return { switched: false, newActiveGroupId: null };
  const state = readState(userId);
  if (!state.fallbackGroupId) {
    // No fallback configured -- pause without a group to switch to, rather than silently doing nothing.
    state.pausedForExtremeConditions = true;
    saveState(userId, state);
    return { switched: false, newActiveGroupId: null };
  }
  state.activeGroupId = state.fallbackGroupId;
  state.pausedForExtremeConditions = true;
  saveState(userId, state);
  return { switched: true, newActiveGroupId: state.fallbackGroupId };
}
