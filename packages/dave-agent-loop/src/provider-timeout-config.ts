import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Real gap fixed (user: "increase the timeout if possible put 2 and 3 to 5 sec settable in
 * settings"): the LLM completion timeout used to be one hardcoded 20s constant (agent-loop.ts's
 * default), applied identically to the PRIMARY provider attempt AND every fallback attempt after
 * it -- so a slow/dead primary could burn a full 20s before ever trying the fallback, and each
 * fallback in the chain could burn another 20s of its own. Real, persisted, per-user config now
 * splits this: the primary provider gets its own (usually longer) timeout, every fallback
 * provider after it gets a separate (usually shorter) timeout so a bad primary doesn't cost the
 * whole chain minutes -- both real, both user-configurable via /settings.
 */

export const DEFAULT_PRIMARY_TIMEOUT_SECONDS = 20;
export const DEFAULT_FALLBACK_TIMEOUT_SECONDS = 5;
export const MIN_TIMEOUT_SECONDS = 3;
export const MAX_TIMEOUT_SECONDS = 120;

export class InvalidProviderTimeoutError extends Error {
  constructor(seconds: number) {
    super(`Timeout must be a whole number of seconds between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS} (got ${seconds}).`);
    this.name = "InvalidProviderTimeoutError";
  }
}

function configPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "provider-timeout", userId, "config.json");
}

interface ProviderTimeoutConfig {
  primarySeconds: number;
  fallbackSeconds: number;
}

function readConfig(userId: string): ProviderTimeoutConfig {
  const path = configPath(userId);
  if (!existsSync(path)) return { primarySeconds: DEFAULT_PRIMARY_TIMEOUT_SECONDS, fallbackSeconds: DEFAULT_FALLBACK_TIMEOUT_SECONDS };
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveConfig(userId: string, config: ProviderTimeoutConfig): void {
  const path = configPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2), "utf8");
}

function validate(seconds: number): void {
  if (!Number.isInteger(seconds) || seconds < MIN_TIMEOUT_SECONDS || seconds > MAX_TIMEOUT_SECONDS) {
    throw new InvalidProviderTimeoutError(seconds);
  }
}

export function getProviderTimeoutConfig(userId: string): ProviderTimeoutConfig {
  return readConfig(userId);
}

export function getProviderTimeoutMs(userId: string, isPrimary: boolean): number {
  const config = readConfig(userId);
  return (isPrimary ? config.primarySeconds : config.fallbackSeconds) * 1000;
}

export function setPrimaryTimeoutSeconds(userId: string, seconds: number): number {
  validate(seconds);
  const config = readConfig(userId);
  saveConfig(userId, { ...config, primarySeconds: seconds });
  return seconds;
}

export function setFallbackTimeoutSeconds(userId: string, seconds: number): number {
  validate(seconds);
  const config = readConfig(userId);
  saveConfig(userId, { ...config, fallbackSeconds: seconds });
  return seconds;
}
