import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Step 18.4: a skip log, deliberately SEPARATE from the trade journal
 * (`@dave/trading`'s journal-worker) -- a trade journal records what
 * Dave DID; this records what Dave looked at and chose NOT to trade,
 * and why. Real signal for reflection: a strategy that skips 9 out of
 * 10 setups it scans is telling you something different than one that
 * takes almost everything, and that pattern lives here, not mixed into
 * the trade journal's own file.
 */

export interface SkipEntry {
  ts: number;
  symbol: string;
  reason: string; // Dave's own real reasoning for skipping -- never authored here
}

function skipLogPath(userId: string): string {
  return join(process.cwd(), "data", "feedback", userId, "skip-log.jsonl");
}

export function recordSkip(userId: string, symbol: string, reason: string): void {
  const path = skipLogPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const entry: SkipEntry = { ts: Date.now(), symbol, reason };
  const line = JSON.stringify(entry) + "\n";
  writeFileSync(path, existsSync(path) ? readFileSync(path, "utf8") + line : line, "utf8");
}

export function readSkipLog(userId: string): SkipEntry[] {
  const path = skipLogPath(userId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** How many skips since a given timestamp -- what a reflection cycle actually needs, not the raw log. */
export function countSkipsSince(userId: string, sinceTs: number): number {
  return readSkipLog(userId).filter((e) => e.ts >= sinceTs).length;
}
