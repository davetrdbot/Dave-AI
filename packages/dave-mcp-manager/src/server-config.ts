import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Real gap fixed (user: "add provision for mcps you added that to the code but you haven't
 * implemented it yet"). mcp-manager.ts's mcpConnect() only ever opens an honestly ephemeral,
 * in-memory live socket -- there was never anywhere to actually SAVE a server's URL/token so the
 * user (or Dave) didn't have to re-supply it every time, and no UI surface at all to manage that.
 * This is that real, persisted provisioning layer: a saved name+url+token per user, independent
 * of whether a live connection currently exists for it.
 */
export interface McpServerConfig {
  id: string;
  name: string;
  url: string;
  token?: string;
  createdAt: number;
}

function configPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "mcp", userId, "servers.json");
}

function readConfigs(userId: string): McpServerConfig[] {
  const path = configPath(userId);
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveConfigs(userId: string, configs: McpServerConfig[]): void {
  const path = configPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(configs, null, 2), "utf8");
}

export class InvalidMcpServerUrlError extends Error {
  constructor() {
    super("An MCP server needs a real URL.");
    this.name = "InvalidMcpServerUrlError";
  }
}

export function addMcpServerConfig(userId: string, name: string, url: string, token?: string): McpServerConfig {
  if (!url || !url.trim()) throw new InvalidMcpServerUrlError();
  const configs = readConfigs(userId);
  const config: McpServerConfig = { id: randomBytes(6).toString("hex"), name: name.trim() || url.trim(), url: url.trim(), token, createdAt: Date.now() };
  configs.push(config);
  saveConfigs(userId, configs);
  return config;
}

export function listMcpServerConfigs(userId: string): McpServerConfig[] {
  return readConfigs(userId);
}

export function getMcpServerConfig(userId: string, id: string): McpServerConfig | undefined {
  return readConfigs(userId).find((c) => c.id === id);
}

export function removeMcpServerConfig(userId: string, id: string): void {
  saveConfigs(userId, readConfigs(userId).filter((c) => c.id !== id));
}

export function resetMcpServerConfigsForUser(userId: string): void {
  rmSync(configPath(userId), { force: true });
}
