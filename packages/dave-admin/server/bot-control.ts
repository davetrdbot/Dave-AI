import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Start/stop and scan-interval control, readable and writable from the admin process.
 *
 * Every value here is a file that ALREADY exists and is already written by the bot --
 * `autonomous-trading-enabled.json` and `autonomous-execution-enabled.json` from
 * dave-agent-loop's autonomous-trading-state.ts, and `trading-loop/<user>/config.json` from its
 * trading-loop-config.ts. Nothing new is invented; this is the read/write half for the other
 * process.
 *
 * Why the logic is duplicated here rather than imported: `@dave/agent-loop` exports only its full
 * barrel (its package.json `exports` map is just "."), which pulls in the telegram server and its
 * entire transitive graph -- workers, safety, sandbox, e2b, firecrawl, notifications, vision,
 * self-improve, mcp-manager. Far too heavy for a Next.js API route that needs to read three small
 * JSON files. This is the same convention, and the same tradeoff, that app/api/trading-loop's own
 * header already documents.
 *
 * The cost of that convention is real: these paths and shapes are kept in sync by hand. step155
 * asserts they match the bot-side modules, so a drift fails a test rather than silently splitting
 * the two processes' view of whether the bot is running.
 */

export const MIN_TRADING_LOOP_MINUTES = 1;
export const MAX_TRADING_LOOP_MINUTES = 60;
export const DEFAULT_TRADING_LOOP_MINUTES = 5;

function root(): string {
  return process.env.DAVE_DATA_ROOT ?? process.cwd();
}

export function tradingFlagPath(userId: string, flag: "autonomous-trading-enabled" | "autonomous-execution-enabled"): string {
  return join(root(), "data", "trading", userId, `${flag}.json`);
}

export function intervalConfigPath(userId: string): string {
  return join(root(), "data", "trading-loop", userId, "config.json");
}

function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(path: string, value: unknown): void {
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value), "utf8");
}

/** Whether autonomous scanning is on. Matches isAutonomousTradingEnabled's default of false. */
export function isBotRunning(userId: string): boolean {
  // Explicit <boolean>: without it the fallback narrows to the literal `false`, and the `=== true`
  // that guards against a file holding something other than a boolean becomes a type error.
  return readJsonFile<boolean>(tradingFlagPath(userId, "autonomous-trading-enabled"), false) === true;
}

export function setBotRunning(userId: string, running: boolean): void {
  writeJsonFile(tradingFlagPath(userId, "autonomous-trading-enabled"), running);
}

/** Whether a normal decision may auto-execute. Defaults TRUE, matching the bot side -- a missing
 *  file must not read as watch-only, or a fresh install would silently never trade. */
export function isExecutionEnabled(userId: string): boolean {
  return readJsonFile<boolean>(tradingFlagPath(userId, "autonomous-execution-enabled"), true) === true;
}

export function setExecutionEnabled(userId: string, enabled: boolean): void {
  writeJsonFile(tradingFlagPath(userId, "autonomous-execution-enabled"), enabled);
}

export function getIntervalMinutes(userId: string): number {
  const parsed = readJsonFile<{ intervalMinutes?: number }>(intervalConfigPath(userId), {});
  return parsed.intervalMinutes ?? DEFAULT_TRADING_LOOP_MINUTES;
}

export class InvalidIntervalError extends Error {
  constructor(minutes: number) {
    super(`Scan interval must be between ${MIN_TRADING_LOOP_MINUTES} and ${MAX_TRADING_LOOP_MINUTES} minutes (got ${minutes}).`);
    this.name = "InvalidIntervalError";
  }
}

export function setIntervalMinutes(userId: string, minutes: number): number {
  if (!Number.isFinite(minutes) || !Number.isInteger(minutes) || minutes < MIN_TRADING_LOOP_MINUTES || minutes > MAX_TRADING_LOOP_MINUTES) {
    throw new InvalidIntervalError(minutes);
  }
  writeJsonFile(intervalConfigPath(userId), { intervalMinutes: minutes });
  return minutes;
}
