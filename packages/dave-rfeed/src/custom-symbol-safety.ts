import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * R_Feed safety rule: custom/synthetic symbols are for analysis only,
 * never for placing even a paper trade. Real MQL5 mechanism (confirmed
 * via research): `SymbolInfoInteger(symbol, SYMBOL_CUSTOM)` -- a real,
 * documented per-symbol boolean the R_Feed EA reports back for every
 * position/pending order in its real reports. This module is the
 * server-side registry built from those real reports, plus the
 * refusal gate every trade-placing path is required to go through.
 */

function registryPath(userId: string): string {
  return join(process.cwd(), "data", "rfeed", userId, "custom-symbols.json");
}

function readRegistry(userId: string): string[] {
  const path = registryPath(userId);
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeRegistry(userId: string, symbols: string[]): void {
  const path = registryPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify([...new Set(symbols)], null, 2), "utf8");
}

export function markSymbolCustom(userId: string, symbol: string): void {
  const registry = readRegistry(userId);
  if (!registry.includes(symbol)) writeRegistry(userId, [...registry, symbol]);
}

export function isKnownCustomSymbol(userId: string, symbol: string): boolean {
  return readRegistry(userId).includes(symbol);
}

export function listKnownCustomSymbols(userId: string): string[] {
  return readRegistry(userId);
}

/** The real ingestion path: every R_Feed report's isCustom flags feed the registry, so it only ever grows from what the EA actually observed. */
export function recordSymbolCustomFlags(userId: string, entries: { symbol: string; isCustom: boolean }[]): void {
  for (const entry of entries) {
    if (entry.isCustom) markSymbolCustom(userId, entry.symbol);
  }
}

export class CustomSymbolTradeRefusedError extends Error {
  constructor(symbol: string) {
    super(`"${symbol}" is flagged as a custom/synthetic symbol -- R_Feed refuses to place even a paper trade on it (analysis only, per the real safety rule)`);
    this.name = "CustomSymbolTradeRefusedError";
  }
}
