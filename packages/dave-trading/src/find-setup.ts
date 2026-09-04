import type { DavemaClient } from "@dave/davema";
import { getActiveGroupInfo } from "./pair-groups.js";

/**
 * Step 10.10: explicit "find me a setup" tool -- scans the current
 * active pair group RIGHT NOW for a trade setup, on demand, separate
 * from normal continuous background analysis. Uses DAVEMA's own
 * /confluence endpoint (0-100 agreement score) per its documented
 * recipe -- this module doesn't invent a scoring method, it calls the
 * real one DAVEMA already provides.
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
}

interface ConfluenceData {
  score: number;
  direction: string;
}

export async function findSetup(userId: string, client: DavemaClient, tf = "H1"): Promise<SetupScanResult> {
  const { activeGroup } = getActiveGroupInfo(userId);
  if (!activeGroup) {
    return { scannedAt: Date.now(), groupName: null, rows: [], bestSetup: null };
  }

  const rows: SetupScanRow[] = await Promise.all(
    activeGroup.symbols.map(async (symbol): Promise<SetupScanRow> => {
      try {
        const data = await client.data<ConfluenceData>("confluence", symbol, tf);
        return { symbol, score: data.score, direction: data.direction };
      } catch (err) {
        return { symbol, score: -1, direction: "unknown", error: err instanceof Error ? err.message : String(err) };
      }
    })
  );

  const ranked = rows.filter((r) => !r.error).sort((a, b) => b.score - a.score);
  return { scannedAt: Date.now(), groupName: activeGroup.name, rows, bestSetup: ranked[0] ?? null };
}
