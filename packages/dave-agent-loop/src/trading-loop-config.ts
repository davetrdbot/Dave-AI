import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Real gap fixed (user: "every 5 min -- make this settable and configurable"): the autonomous
 * trading cycle's cadence (trading-loop.ts) used to be a hardcoded constant. This is real,
 * persisted (survives a restart/redeploy, same JSON-file-per-user convention pair-groups.ts and
 * friends already use), per-user config for it, with sane bounds so a fat-fingered "0" can't
 * spin the loop into a hot busy-cycle and a huge number can't silently defeat the point of it.
 *
 * Restored to real per-user configurability (a prior change had briefly locked this to a
 * mandatory 1-minute cadence for everyone -- the trader has since confirmed the default should
 * go back to 5 minutes, adjustable down to 1-2 minutes via /start_trading <minutes> when they
 * want a faster scan). The EA's own push interval (how fresh the underlying price/candle data
 * is) is a separate, already-1-second setting -- this constant only governs how often Dave runs
 * a full paid LLM decision cycle per symbol.
 */
export const DEFAULT_TRADING_LOOP_MINUTES = 5;
export const MIN_TRADING_LOOP_MINUTES = 1;
export const MAX_TRADING_LOOP_MINUTES = 60;

export class InvalidTradingLoopIntervalError extends Error {
  constructor(minutes: number) {
    super(`Trading loop interval must be a whole number of minutes between ${MIN_TRADING_LOOP_MINUTES} and ${MAX_TRADING_LOOP_MINUTES} (got ${minutes}).`);
    this.name = "InvalidTradingLoopIntervalError";
  }
}

function configPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading-loop", userId, "config.json");
}

interface TradingLoopConfig {
  intervalMinutes: number;
}

function readConfig(userId: string): TradingLoopConfig {
  const path = configPath(userId);
  if (!existsSync(path)) return { intervalMinutes: DEFAULT_TRADING_LOOP_MINUTES };
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveConfig(userId: string, config: TradingLoopConfig): void {
  const path = configPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2), "utf8");
}

export function getTradingLoopIntervalMinutes(userId: string): number {
  return readConfig(userId).intervalMinutes;
}

export function getTradingLoopIntervalMs(userId: string): number {
  return getTradingLoopIntervalMinutes(userId) * 60_000;
}

export function setTradingLoopIntervalMinutes(userId: string, minutes: number): number {
  if (!Number.isInteger(minutes) || minutes < MIN_TRADING_LOOP_MINUTES || minutes > MAX_TRADING_LOOP_MINUTES) {
    throw new InvalidTradingLoopIntervalError(minutes);
  }
  saveConfig(userId, { intervalMinutes: minutes });
  return minutes;
}
