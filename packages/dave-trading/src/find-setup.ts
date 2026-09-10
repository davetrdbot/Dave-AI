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

  const rows: SetupScanRow[] = await Promise.all(
    effectiveSymbols.map(async (symbol): Promise<SetupScanRow> => {
      try {
        const data = await analysis.get<ConfluenceData>("confluence", symbol, tf);
        return { symbol, score: data.score, direction: data.direction };
      } catch (err) {
        return { symbol, score: -1, direction: "unknown", error: err instanceof Error ? err.message : String(err) };
      }
    })
  );

  const ranked = rows.filter((r) => !r.error).sort((a, b) => b.score - a.score);
  const groupName = activePairSymbol ? `${activePairSymbol} (single pair)` : (activeGroup?.name ?? null);
  return { scannedAt: Date.now(), groupName, rows, bestSetup: ranked[0] ?? null };
}
