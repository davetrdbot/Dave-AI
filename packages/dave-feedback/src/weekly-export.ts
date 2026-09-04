import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerScheduledTrigger, unregisterScheduledTrigger, type ScheduledTrigger } from "@dave/db";
import type { DaveDatabase } from "@dave/db";
import { listTradesSince } from "./trade-log.js";
import { readSkipLog } from "./skip-log.js";
import { readHypotheses } from "./hypotheses.js";

/**
 * Step 18.6: weekly dataset export, a real scheduled job (not a manual
 * "export" button that happens to exist). Default weekly (Sunday
 * 04:00 UTC, an hour after the dreaming cron so it can include that
 * run's output), writes a real JSON file to disk every time it fires.
 */

export const DEFAULT_EXPORT_CRON = "0 4 * * 0";

export interface WeeklyExportResult {
  path: string;
  tradeCount: number;
  skipCount: number;
  hypothesisCount: number;
  exportedAt: number;
}

export function runWeeklyExport(db: DaveDatabase, ownerUserId: string, exportRoot: string): WeeklyExportResult {
  const trades = listTradesSince(db, ownerUserId, 0);
  const skips = readSkipLog(ownerUserId);
  const hypotheses = readHypotheses(ownerUserId);
  const exportedAt = Date.now();

  const dir = join(exportRoot, ownerUserId, "exports");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, `${new Date(exportedAt).toISOString().slice(0, 10)}.json`);
  writeFileSync(path, JSON.stringify({ exportedAt, trades, skips, hypotheses }, null, 2), "utf8");

  return { path, tradeCount: trades.length, skipCount: skips.length, hypothesisCount: hypotheses.length, exportedAt };
}

export function registerWeeklyExportCron(
  db: DaveDatabase,
  ownerUserId: string,
  exportRoot: string,
  onExported?: (result: WeeklyExportResult) => void,
  cronExpression: string = DEFAULT_EXPORT_CRON
): ScheduledTrigger {
  return registerScheduledTrigger(`weekly-export-${ownerUserId}`, cronExpression, () => {
    const result = runWeeklyExport(db, ownerUserId, exportRoot);
    onExported?.(result);
  });
}

export function unregisterWeeklyExportCron(ownerUserId: string): void {
  unregisterScheduledTrigger(`weekly-export-${ownerUserId}`);
}
