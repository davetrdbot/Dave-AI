import type { AnalysisSource } from "./analysis-source.js";
import { getActiveGroupInfo, ensureGroupsUsable } from "./pair-groups.js";
import { isWithinSelectedSession } from "./trading-session-config.js";

/**
 * Step 10.10: explicit "find me a setup" tool -- scans the current
 * active pair group RIGHT NOW for a trade setup, on demand, separate
 * from normal continuous background analysis. Uses a real confluence
 * score (0-100 agreement) computed by the connected MT5 EA itself (item
 * 5, DAVEMA retirement) -- this module doesn't invent a scoring method,
 * it calls the real one the EA already provides.
 */

export interface SetupScanRow {
  symbol: string;
  score: number;
  direction: string;
  error?: string;
}

export interface SetupScanResult {
  scannedAt: number;
  groupName: string | null;
  rows: SetupScanRow[];
  bestSetup: SetupScanRow | null;
  /** Real gap fixed (user: "in settings to select the session you want it to trade and also a
   *  option to put all so it can trade all sessions"): true when this scan was genuinely skipped
   *  because the real current UTC time isn't in the user's selected session window. */
  skippedOutsideSession?: boolean;
}

interface ConfluenceData {
  score: number;
  direction: string;
}

export async function findSetup(userId: string, analysis: AnalysisSource, tf = "H1"): Promise<SetupScanResult> {
  // Real bug fixed (user: "the bot doesn't even know the pair to trade"): a user who never
  // manually visited /settings -> Pair Group had zero groups and no active one, so a real scan
  // had nothing to look at. Self-heals right before the real scan (seeds the default groups +
  // activates a sensible default) -- never touches a user's own explicit choice once one exists.
  ensureGroupsUsable(userId);
  // Real gap fixed (user: "add active pair so incase a user doesn't want to use a group of pair
  // it can select a pair the bot can focus only"): effectiveSymbols honors a real single-pair
  // override when one is set, instead of always scanning the whole active group.
  const { activeGroup, activePairSymbol, effectiveSymbols } = getActiveGroupInfo(userId);
  if (effectiveSymbols.length === 0) {
    return { scannedAt: Date.now(), groupName: null, rows: [], bestSetup: null };
  }
  if (!isWithinSelectedSession(userId)) {
    const groupName = activePairSymbol ? `${activePairSymbol} (single pair)` : (activeGroup?.name ?? null);
    return { scannedAt: Date.now(), groupName, rows: [], bestSetup: null, skippedOutsideSession: true };
  }

  const rows = await scanSymbols(analysis, effectiveSymbols, tf);
  const ranked = rows.filter((r) => !r.error).sort((a, b) => b.score - a.score);
  const groupName = activePairSymbol ? `${activePairSymbol} (single pair)` : (activeGroup?.name ?? null);
  return { scannedAt: Date.now(), groupName, rows, bestSetup: ranked[0] ?? null };
}

/**
 * Real bug fixed (user, live: "scanning the full active pair group fails on every symbol with
 * 'no response from EA within 15000ms', while individual per-symbol calls work fine"). Root
 * cause confirmed: this used to fire every symbol's request at once via a bare Promise.all --
 * the EA is single-threaded and processes a whole drained batch serially in one blocking tick,
 * so N concurrent requests all missed the same 15s deadline together, even though most would
 * have succeeded fine on their own. Two real fixes, both needed:
 *   1. Here: a genuine staggered queue -- at most SCAN_CONCURRENCY requests in flight at once,
 *      matching the EA bridge's own per-poll "analyze" cap (ea-webhook.ts), so the EA is never
 *      handed more than it can realistically process in one tick.
 *   2. A longer per-request timeout for a GROUP scan specifically (still short for a genuine
 *      single ad-hoc call) -- even with staggering, a symbol whose history isn't yet
 *      synchronized in the terminal can legitimately take a couple of EA ticks to resolve.
 */
const SCAN_CONCURRENCY = 6;
const GROUP_SCAN_TIMEOUT_MS = 45000;

async function scanSymbols(analysis: AnalysisSource, symbols: string[], tf: string, exclude: Set<string> = new Set()): Promise<SetupScanRow[]> {
  const targets = symbols.filter((s) => !exclude.has(s));
  const results: SetupScanRow[] = new Array(targets.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < targets.length) {
      const index = cursor++;
      const symbol = targets[index];
      try {
        const data = await analysis.get<ConfluenceData>("confluence", symbol, tf, { timeoutMs: GROUP_SCAN_TIMEOUT_MS });
        results[index] = { symbol, score: data.score, direction: data.direction };
      } catch (err) {
        results[index] = { symbol, score: -1, direction: "unknown", error: err instanceof Error ? err.message : String(err) };
      }
    }
  }

  const workerCount = Math.min(SCAN_CONCURRENCY, targets.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export interface HuntResult extends SetupScanResult {
  /** True when this result came from broadening beyond the primary scan (a single-pair focus
   *  that had nothing good, or an explicit exclusion like "Find Another" forcing a re-scan). */
  huntModeActivated: boolean;
}

/** Real, minimum confluence score item 2/6 treats as "worth taking" before hunt mode gives up on
 *  the primary scan and broadens -- matches the same floor confidence-gate.ts's default threshold
 *  implies (70), kept slightly below it since this is "worth a look," not "worth auto-firing." */
export const HUNT_MODE_MIN_SCORE = 60;

/**
 * Item 2/6 real gap fixed (user: "'hunt for a setup and place it' should mean Dave actively
 * scans the ACTIVE PAIR GROUP... and looks for a real setup across it, RIGHT NOW... if no clean
 * setup exists on the currently configured/active pair, Dave does NOT just stop -- it activates
 * 'Hunt Mode'... actively scanning OTHER available pairs in the same group"). findSetup() already
 * scans the whole group by default -- the real gap was specifically when a single-pair FOCUS
 * (setActivePairSymbol) is active: findSetup only ever looked at that one pair, so a weak/no
 * setup on it just... stopped, with nothing broader tried. This broadens to the rest of the
 * active group when the primary scan doesn't clear HUNT_MODE_MIN_SCORE, and (for a real "Find
 * Another" re-hunt) can also exclude specific symbols already declined.
 */
export async function huntForSetup(userId: string, analysis: AnalysisSource, tf = "H1", opts: { excludeSymbols?: string[] } = {}): Promise<HuntResult> {
  const exclude = new Set(opts.excludeSymbols ?? []);
  ensureGroupsUsable(userId);
  const info = getActiveGroupInfo(userId);

  // Real bug fixed (user, live: "it doesn't extract info from the market watch only the pair I
  // add to do big check"): a single-pair focus (setActivePairSymbol) used to make hunt mode
  // scan ONLY that one symbol unless its own score fell below HUNT_MODE_MIN_SCORE -- so a group
  // with several real synthetic pairs configured was never actually checked while the focused
  // pair scored decently, which reads exactly like "only checking the one pair I added." Hunting
  // must always cover every symbol in the real active group, not just a focused pair -- a single
  // pair focus is honored by find_setup (an explicit, deliberate "check just this one" request),
  // never by the autonomous hunt loop.
  const group = info.activeGroup;
  const symbols = group && group.symbols.length > 0 ? group.symbols : info.effectiveSymbols;
  if (symbols.length === 0) {
    return { scannedAt: Date.now(), groupName: null, rows: [], bestSetup: null, huntModeActivated: false };
  }
  if (!isWithinSelectedSession(userId)) {
    return { scannedAt: Date.now(), groupName: group?.name ?? info.activePairSymbol, rows: [], bestSetup: null, skippedOutsideSession: true, huntModeActivated: false };
  }

  const rows = await scanSymbols(analysis, symbols, tf, exclude);
  const ranked = rows.filter((r) => !r.error).sort((a, b) => b.score - a.score);
  return {
    scannedAt: Date.now(),
    groupName: group?.name ?? info.activePairSymbol,
    rows,
    bestSetup: ranked[0] ?? null,
    huntModeActivated: symbols.length > 1,
  };
}
