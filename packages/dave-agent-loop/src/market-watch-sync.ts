import { randomBytes } from "node:crypto";
import { enqueueCommand, type EaCommandResult } from "@dave/ea-bridge";
import { ensureGroupsUsable } from "@dave/trading";

/**
 * Every pair from every pair group goes into MT5's Market Watch automatically (the trader: "the
 * market watch -- all those group pairs should be automatically added"). Sent to the EA as one
 * "market_watch" command: on boot, whenever the EA (re)connects -- a fresh terminal or a new login
 * starts with the broker's default list -- and whenever a group's pairs change.
 *
 * Also the first thing that seeds a fresh deploy's pair groups (ensureGroupsUsable), so a new
 * account has the groups from the start instead of only after its first scan.
 */
export function allGroupSymbols(userId: string): string[] {
  const seen = new Set<string>();
  for (const g of ensureGroupsUsable(userId).groups) {
    for (const s of g.symbols) {
      const sym = s.trim().toUpperCase();
      if (sym && !sym.includes(",")) seen.add(sym);
    }
  }
  return [...seen];
}

export interface MarketWatchSync {
  /** Sends the list if it changed since the last send, or always when `force`. Returns whether it sent. */
  sync(force?: boolean): boolean;
  /** The EA's answer to a market_watch command this syncer sent, else undefined. */
  describeResult(result: EaCommandResult): string | undefined;
}

export function createMarketWatchSync(userId: string, enqueue = enqueueCommand): MarketWatchSync {
  let lastSent = "";
  const sentIds = new Set<string>();
  return {
    sync(force = false) {
      const symbols = allGroupSymbols(userId).join(",");
      if (!symbols || (!force && symbols === lastSent)) return false;
      const id = randomBytes(6).toString("hex");
      enqueue(userId, { id, action: "market_watch", symbols });
      sentIds.add(id);
      lastSent = symbols;
      return true;
    },
    describeResult(result) {
      if (!sentIds.delete(result.commandId)) return undefined;
      return `${result.status === "ok" ? "" : "failed: "}${result.message ?? ""}`;
    },
  };
}
