import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BreakevenTrailingConfig } from "./breakeven-trailing.js";

/**
 * Update 18: a real per-user default breakeven/trailing config store --
 * `processPriceTick` (Step 10.9) always took a config as a plain
 * argument; this is what a `set_trailing_stop_config` tool actually
 * persists so the same numbers don't need re-supplying on every tick.
 */
function configPath(userId: string): string {
  return join(process.cwd(), "data", "trading", userId, "trailing-config.json");
}

export function getTrailingStopConfig(userId: string): BreakevenTrailingConfig | undefined {
  const path = configPath(userId);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8"));
}

export function setTrailingStopConfig(userId: string, config: BreakevenTrailingConfig): void {
  const path = configPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2), "utf8");
}
