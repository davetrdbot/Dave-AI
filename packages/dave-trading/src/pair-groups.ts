import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendSettingsLogEntry } from "./settings-log.js";

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

export interface GroupState {
  groups: PairGroup[];
  activeGroupId: string | null;
  fallbackGroupId: string | null;
  pausedForExtremeConditions: boolean;
  /** Real gap fixed (user: "add active pair so incase a user doesn't want to use a group of pair
   *  it can select a pair the bot can focus only"): a real, optional override -- when set, Dave
   *  scans/trades ONLY this one symbol instead of the whole active group's symbol list. Setting
   *  the active GROUP does not clear this; the user explicitly clears it (or picks a different
   *  active pair) to go back to scanning the full group. */
  activePairSymbol: string | null;
}

const EMPTY_STATE: GroupState = { groups: [], activeGroupId: null, fallbackGroupId: null, pausedForExtremeConditions: false, activePairSymbol: null };

function statePath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "pair-groups.json");
}

/**
 * User-corrected (real, explicit): this project only uses Headway broker synthetics, never Deriv,
 * but the old default seed list included Deriv-style "_INDEX"-suffixed symbols (VOLATILITY_*_INDEX,
 * BOOM_*_INDEX, STEP_INDEX, etc.) that may already be persisted in a real user's saved "synthetic"
 * group from before this fix. Strips them out of any already-saved synthetic group on every read --
 * targeted at the "_INDEX" suffix specifically (not a full overwrite), so it never touches symbols a
 * user genuinely added themselves to any OTHER group.
 */
function stripDerivSyntheticSymbols(state: GroupState): GroupState {
  let changed = false;
  const groups = state.groups.map((g) => {
    if (g.id !== "synthetic") return g;
    const cleaned = g.symbols.filter((s) => !s.includes("_INDEX"));
    if (cleaned.length === g.symbols.length) return g;
    changed = true;
    return { ...g, symbols: cleaned };
  });
  return changed ? { ...state, groups } : state;
}

/**
 * FLAMES removed entirely (trader, live). The broker's terminal never had enough history loaded
 * for it -- every timeframe came back "not enough real history loaded yet", every cycle, so it
 * only ever cost a scan slot and produced nothing. Taken out of the default seed below, and
 * stripped here from every already-persisted group (and from a single-pair focus) on read, so
 * existing accounts lose it too. The old misspelling "FLAME" goes the same way.
 */
const REMOVED_SYMBOLS = new Set(["FLAMES", "FLAME"]);

function removeRetiredSymbols(state: GroupState): GroupState {
  let changed = false;
  const groups = state.groups.map((g) => {
    if (!g.symbols.some((s) => REMOVED_SYMBOLS.has(s))) return g;
    changed = true;
    return { ...g, symbols: g.symbols.filter((s) => !REMOVED_SYMBOLS.has(s)) };
  });
  const activePairSymbol = state.activePairSymbol !== null && REMOVED_SYMBOLS.has(state.activePairSymbol) ? null : state.activePairSymbol;
  if (activePairSymbol !== state.activePairSymbol) changed = true;
  return changed ? { ...state, groups, activePairSymbol } : state;
}

function readState(userId: string): GroupState {
  const path = statePath(userId);
  if (!existsSync(path)) return { ...EMPTY_STATE, groups: [] };
  // activePairSymbol defaults to null for state files persisted before this field existed.
  const raw: GroupState = { activePairSymbol: null, ...JSON.parse(readFileSync(path, "utf8")) };
  const cleaned = removeRetiredSymbols(stripDerivSyntheticSymbols(raw));
  if (cleaned !== raw) saveState(userId, cleaned);
  return cleaned;
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
  const oldGroupId = state.activeGroupId;
  state.activeGroupId = groupId;
  state.pausedForExtremeConditions = false;
  saveState(userId, state);
  appendSettingsLogEntry(userId, "activePairGroup", oldGroupId, groupId);
}

export function setFallbackGroup(userId: string, groupId: string): void {
  const state = readState(userId);
  if (!state.groups.some((g) => g.id === groupId)) throw new UnknownGroupError(groupId);
  state.fallbackGroupId = groupId;
  saveState(userId, state);
}

/** Real gap fixed (user: "add active pair so incase a user doesn't want to use a group of pair it
 *  can select a pair the bot can focus only"): narrows scanning/trading down to exactly this one
 *  symbol, real, persisted, independent of which group is active. */
export function setActivePairSymbol(userId: string, symbol: string): void {
  const state = readState(userId);
  state.activePairSymbol = symbol.trim().toUpperCase();
  saveState(userId, state);
}

/** Clears the single-pair override -- Dave goes back to scanning the whole active group. */
export function clearActivePairSymbol(userId: string): void {
  const state = readState(userId);
  state.activePairSymbol = null;
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

/**
 * Item 8 (Batch B): exactly 8 real seeded groups -- 7 named categories plus one
 * empty, user-configurable Fallback group (no "Local" category, per the user's
 * explicit spec). Symbol lists are the user's own real lists, verbatim -- not
 * invented. Seeding is additive-only (see seedDefaultPairGroups below): it never
 * overwrites a group the user has since edited or renamed via the admin panel's
 * pair-group designer, which still works unmodified on top of this.
 */
export const DEFAULT_PAIR_GROUPS: PairGroup[] = [
  {
    // User-corrected (real, explicit): this project only uses Headway broker synthetics, not
    // Deriv -- every "_INDEX"-suffixed Deriv-style symbol previously seeded here has been removed.
    id: "synthetic",
    name: "Synthetic",
    // FLAMES removed at the trader's request -- see removeRetiredSymbols above.
    symbols: ["VOL_10", "VOL_20", "VOL_80", "BOOM_100", "BOOM_200", "STORM_200", "STORM_500", "CRASH_100", "CRASH_200"],
  },
  {
    id: "forex",
    name: "Forex",
    symbols: [
      "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD", "NZDUSD", "EURGBP", "EURJPY", "GBPJPY",
      "EURAUD", "EURCHF", "EURCAD", "EURNZD", "GBPAUD", "GBPCAD", "GBPCHF", "GBPNZD", "AUDJPY", "AUDCAD",
      "AUDCHF", "AUDNZD", "CADJPY", "CADCHF", "CHFJPY", "NZDJPY", "NZDCAD", "NZDCHF",
    ],
  },
  {
    id: "crypto",
    name: "Crypto",
    symbols: ["BTCUSD", "ETHUSD", "SOLUSD", "XRPUSD", "ADAUSD", "DOGEUSD", "BNBUSD", "BTCUSDT", "ETHUSDT", "SOLUSDT", "LTCUSD", "AVAXUSD"],
  },
  { id: "metals", name: "Metals", symbols: ["XAUUSD", "XAGUSD", "XPTUSD", "XPDUSD"] },
  { id: "indexes", name: "Indexes", symbols: ["US30", "US100", "NAS100", "SPX500", "GER40", "UK100", "JP225", "AUS200"] },
  { id: "energies", name: "Energies", symbols: ["USOIL", "UKOIL", "NGAS"] },
  {
    id: "stocks",
    name: "Stocks",
    symbols: [
      "AAPL", "MSFT", "GOOGL", "AMZN", "TSLA", "META", "NVDA", "NFLX", "AMD", "INTC",
      "BA", "DIS", "KO", "PEP", "WMT", "JPM", "V", "MA", "XOM", "PFE",
    ],
  },
  { id: "fallback", name: "Fallback", symbols: [] },
];

/**
 * Additive, idempotent seeding: adds any DEFAULT_PAIR_GROUPS entry whose id the
 * user doesn't already have (by id, not name), never touching/overwriting a
 * group the user already has under that id -- so re-running this after the
 * user has renamed/edited a seeded group or added their own via the admin
 * panel designer never clobbers their edits, and never duplicates. Returns the
 * groups actually added.
 */
export function seedDefaultPairGroups(userId: string): PairGroup[] {
  const state = readState(userId);
  const existingIds = new Set(state.groups.map((g) => g.id));
  const added = DEFAULT_PAIR_GROUPS.filter((g) => !existingIds.has(g.id));
  if (added.length === 0) return [];
  state.groups.push(...added);
  saveState(userId, state);
  return added;
}

export interface ActiveGroupInfo {
  activeGroup: PairGroup | null;
  fallbackGroup: PairGroup | null;
  pausedForExtremeConditions: boolean;
  /** Real, persisted single-pair override -- null when scanning the whole active group. */
  activePairSymbol: string | null;
  /** The REAL symbol list to actually scan/trade right now: just [activePairSymbol] when a
   *  single-pair override is set, otherwise the full active group's symbols (or [] if no group
   *  is active either). Every real caller (find-setup.ts, the trading loop, etc.) should use
   *  THIS, not activeGroup.symbols directly, so the override is honored everywhere consistently. */
  effectiveSymbols: string[];
}

/**
 * Real bug fixed (user: "the bot doesn't even know the pair to trade"): groups previously only
 * ever got seeded/activated when the user manually opened /settings -> Pair Group and tapped
 * Active -- a user who never did that had ZERO groups and no active group, so find_setup
 * genuinely had nothing to scan and Dave had no pairs at all. Deliberately NOT wired into
 * getActiveGroupInfo/readState directly (those stay pure reads -- a user genuinely building their
 * own groups from scratch, e.g. via the admin panel or create_or_update_pair_group, must still see
 * an honest empty list until they add one). find-setup.ts calls this specifically, right before a
 * real scan, since that's the one real consumer where "nothing to scan" is the actual reported bug.
 */
export function ensureGroupsUsable(userId: string): GroupState {
  const state = readState(userId);
  let next = state;
  if (next.groups.length === 0) {
    next = { ...next, groups: [...DEFAULT_PAIR_GROUPS] };
  }
  if (!next.activeGroupId || !next.groups.some((g) => g.id === next.activeGroupId)) {
    next = { ...next, activeGroupId: next.groups.some((g) => g.id === "synthetic") ? "synthetic" : (next.groups[0]?.id ?? null) };
  }
  if (!next.fallbackGroupId || !next.groups.some((g) => g.id === next.fallbackGroupId)) {
    next = { ...next, fallbackGroupId: next.groups.some((g) => g.id === "fallback") ? "fallback" : null };
  }
  if (next !== state) saveState(userId, next);
  return next;
}

export function getActiveGroupInfo(userId: string): ActiveGroupInfo {
  const state = readState(userId);
  const activeGroup = state.groups.find((g) => g.id === state.activeGroupId) ?? null;
  return {
    activeGroup,
    fallbackGroup: state.groups.find((g) => g.id === state.fallbackGroupId) ?? null,
    pausedForExtremeConditions: state.pausedForExtremeConditions,
    activePairSymbol: state.activePairSymbol,
    effectiveSymbols: state.activePairSymbol ? [state.activePairSymbol] : (activeGroup?.symbols ?? []),
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
