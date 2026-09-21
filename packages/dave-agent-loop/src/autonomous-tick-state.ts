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
  action: "BUY" | "SELL" | "SKIP" | "ASK" | "DELETE_TICKET" | "PARTIAL_CLOSE" | "MODIFY" | "PAUSE" | "CONSULT_JOURNAL" | "REQUEST_CANDLES" | "RUN_SCRIPT";
  reason: string;
}

export interface TickState {
  recentDecisions: TickDecisionRecord[];
  huntSkipCount: number;
  huntLastSymbol: string | null;
  /** Real round-robin cursor (user's explicit spec: "it should send the pairs one by one... when
   *  it has scanned like 3 times in a row it should check fallback and scan a row then move back
   *  to the synthetic"). Index into whichever list is currently active. Real bug this also fixed:
   *  the old ad-hoc per-symbol cooldown (skip re-signaling within 90s) never advanced past a SKIP
   *  decision, so the exact same first-eligible symbol got re-picked every tick -- superseded by
   *  this cursor, which always advances regardless of decision. */
  symbolCursor: number;
  scanningFallback: boolean;
  primaryLapsCompleted: number;
  /** Real, live feature (user: the model can ask "analyze SYMBOL next, because REASON" on any
   *  decision, and the round-robin should honor that specific symbol on the VERY NEXT cycle
   *  instead of whatever's mechanically next in the array). Set right after a decision carrying
   *  `requestedNextSymbol` is recorded, overwriting any previous pending override -- consumed
   *  exactly once by the next call to resolveCursorSymbol (see autonomous-tick.ts), whether or not
   *  the requested symbol turns out to still be valid to analyze. */
  pendingSymbolOverride?: { symbol: string; reason: string; requestedAt: number };
}

const DEFAULT_STATE: TickState = { recentDecisions: [], huntSkipCount: 0, huntLastSymbol: null, symbolCursor: 0, scanningFallback: false, primaryLapsCompleted: 0 };
const MAX_RECENT = 3;

function statePath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "agent-loop", userId, "autonomous-tick-state.json");
}

export function getTickState(userId: string): TickState {
  const path = statePath(userId);
  if (!existsSync(path)) return { ...DEFAULT_STATE };
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

/**
 * Real round-robin symbol cycling, user's explicit spec: "it should send the pairs one by one...
 * for example VOL_10 firstly get all analysis... then when the bot decide... it should move to
 * the next which is VOL_20... continue like that and cover the full pair, when it has scanned
 * like 3 times in a row it should check fallback and scan a row then move back to the synthetic."
 *
 * Real bug this also fixes: before this cursor existed, a SKIP decision set no cooldown, so the
 * exact same first-eligible symbol in the group's array order got re-picked every single tick --
 * the autonomous loop never actually advanced through the rest of a normal active group over
 * time. The cursor advances on EVERY real decision (BUY/SELL/SKIP/ASK alike), so the loop always
 * visits its next symbol next time, never gets stuck re-asking about the one it just decided on.
 */
export const PRIMARY_LAPS_BEFORE_FALLBACK = 3;

/** Which list is active right now, and the index within it -- caller resolves this against the
 *  real current primary/fallback symbol arrays (group membership can change between ticks). */
export function getCursorPosition(userId: string): { symbolCursor: number; scanningFallback: boolean } {
  const { symbolCursor, scanningFallback } = getTickState(userId);
  return { symbolCursor, scanningFallback };
}

/** Advances the cursor by one for next tick, wrapping and switching between primary/fallback per
 *  the real spec above. Call once per real decision, after the symbol for THIS tick was already
 *  resolved from getCursorPosition. `fallbackLength` of 0 (no fallback group configured) means
 *  the cursor only ever wraps within the primary list, exactly as before. */
export function advanceCursor(userId: string, primaryLength: number, fallbackLength: number): void {
  const state = getTickState(userId);
  const activeLength = state.scanningFallback ? fallbackLength : primaryLength;
  if (activeLength <= 0) {
    state.symbolCursor = 0;
    state.scanningFallback = false;
    saveTickState(userId, state);
    return;
  }
  const next = state.symbolCursor + 1;
  if (next < activeLength) {
    state.symbolCursor = next;
    saveTickState(userId, state);
    return;
  }
  // A full lap just completed.
  if (state.scanningFallback) {
    state.scanningFallback = false;
    state.primaryLapsCompleted = 0;
  } else {
    state.primaryLapsCompleted += 1;
    if (state.primaryLapsCompleted >= PRIMARY_LAPS_BEFORE_FALLBACK && fallbackLength > 0) {
      state.scanningFallback = true;
    }
  }
  state.symbolCursor = 0;
  saveTickState(userId, state);
}

/** Persists a real requested-next-symbol override, overwriting any previous one -- called right
 *  after a decision carrying `requestedNextSymbol` is recorded, regardless of that decision's own
 *  action (BUY/SELL/SKIP/etc). */
export function setPendingSymbolOverride(userId: string, symbol: string, reason: string): void {
  const state = getTickState(userId);
  state.pendingSymbolOverride = { symbol, reason, requestedAt: Date.now() };
  saveTickState(userId, state);
}

/** Reads and clears the real pending override in one step -- consumed exactly once, whether or
 *  not the caller ultimately finds the requested symbol still valid to analyze this cycle. */
export function consumePendingSymbolOverride(userId: string): { symbol: string; reason: string; requestedAt: number } | null {
  const state = getTickState(userId);
  const override = state.pendingSymbolOverride ?? null;
  if (override) {
    state.pendingSymbolOverride = undefined;
    saveTickState(userId, state);
  }
  return override;
}
