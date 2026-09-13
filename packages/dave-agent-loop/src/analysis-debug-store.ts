import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Real gap fixed (user: doubted `get_all_analysis` genuinely fetches the FULL analysis suite
 * across every configured timeframe/endpoint rather than something silently partial or stubbed).
 * This is the user-visible half -- a real, file-backed, per-user rolling record of what the real
 * two `get_all_analysis`-shaped fetch sites (autonomous-tick.ts's merged multi-timeframe suite,
 * and dave-ea-bridge's own `get_all_analysis` tool) ACTUALLY got back, so `/last_analysis` in
 * Telegram can show it plainly and Claude can independently verify it via the matching
 * `[analysis-debug]` log line emitted at the same real call sites. Same file-backed per-user JSON
 * pattern as busy-state.ts/self-pause.ts (DAVE_DATA_ROOT-rooted path, existsSync/mkdirSync/
 * readFileSync/writeFileSync), not a new storage mechanism.
 */
export interface AnalysisDebugEntry {
  symbol: string;
  timeframesRequested: string[];
  timeframesReceived: string[];
  endpointKeysPerTimeframe: Record<string, string[]>;
  totalPayloadBytes: number;
  fetchedAt: number;
  rawSuite: unknown;
}

/** Cap on how many recent fetches are kept per user -- a rolling window, not an unbounded log. */
export const MAX_ANALYSIS_DEBUG_ENTRIES = 5;

function analysisDebugPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "agent-loop", userId, "analysis-debug.json");
}

function readEntries(userId: string): AnalysisDebugEntry[] {
  const path = analysisDebugPath(userId);
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf8")) as AnalysisDebugEntry[] | null;
  return Array.isArray(raw) ? raw : [];
}

function writeEntries(userId: string, entries: AnalysisDebugEntry[]): void {
  const path = analysisDebugPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(entries), "utf8");
}

/**
 * Appends a real recorded analysis fetch, stored oldest-first on disk, capped at
 * MAX_ANALYSIS_DEBUG_ENTRIES per user (drops the oldest once the cap would be exceeded).
 */
export function recordAnalysisFetch(userId: string, entry: AnalysisDebugEntry): void {
  const entries = readEntries(userId);
  entries.push(entry);
  while (entries.length > MAX_ANALYSIS_DEBUG_ENTRIES) entries.shift();
  writeEntries(userId, entries);
}

/** Returns recorded fetches, most recent first. */
export function getRecentAnalysisFetches(userId: string): AnalysisDebugEntry[] {
  return readEntries(userId).slice().reverse();
}
