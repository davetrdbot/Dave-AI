import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Real gap fixed (user: "when sending the ea it normally does need a ui that's not necessary...
 * the ui should be Dave EA and mcp for trading so incase they don't want to use the ea I can
 * provide my mcp for the placing of trade and others"). A real, complete McpTradeExecutor
 * (mcp-trade-adapter.ts) already existed -- a genuine alternative to the file-based MT5 EA for
 * placing trades -- but nothing ever let a user actually choose it: no persisted preference, no
 * UI. This is that real, persisted, per-user choice.
 */

export type TradingMode = "ea" | "mcp";

export interface TradingModeConfig {
  mode: TradingMode;
  mcpServerUrl?: string;
}

function configPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading-mode", userId, "config.json");
}

export function getTradingModeConfig(userId: string): TradingModeConfig {
  const path = configPath(userId);
  if (!existsSync(path)) return { mode: "ea" };
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveConfig(userId: string, config: TradingModeConfig): void {
  const path = configPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2), "utf8");
}

export function setEaTradingMode(userId: string): TradingModeConfig {
  const config: TradingModeConfig = { mode: "ea" };
  saveConfig(userId, config);
  return config;
}

export class MissingMcpServerUrlError extends Error {
  constructor() {
    super("An MCP server URL is required to switch to MCP-based trading.");
    this.name = "MissingMcpServerUrlError";
  }
}

export function setMcpTradingMode(userId: string, mcpServerUrl: string): TradingModeConfig {
  if (!mcpServerUrl.trim()) throw new MissingMcpServerUrlError();
  const config: TradingModeConfig = { mode: "mcp", mcpServerUrl: mcpServerUrl.trim() };
  saveConfig(userId, config);
  return config;
}
