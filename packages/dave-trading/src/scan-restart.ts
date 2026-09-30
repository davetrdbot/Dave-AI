import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * "Start the scan from the first pair again" (the trader: "after scanning all pairs ... start from
 * VOL_10", and "add a button to restart the mode 2"). The scan's position lives in the bot's own
 * state; the app, Telegram and the start switch only leave this request, which the next scan
 * picks up before choosing its pair.
 */

function path(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "scan-restart.json");
}

export function requestScanRestart(userId: string, source = "app"): void {
  const p = path(userId);
  if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ at: Date.now(), source }), "utf8");
}

/** The pending request, removed as it is read -- so it is acted on exactly once. */
export function consumeScanRestart(userId: string): { at: number; source: string } | undefined {
  const p = path(userId);
  if (!existsSync(p)) return undefined;
  try {
    const v = JSON.parse(readFileSync(p, "utf8")) as { at: number; source: string };
    return v;
  } catch {
    return { at: Date.now(), source: "unknown" };
  } finally {
    rmSync(p, { force: true });
  }
}
