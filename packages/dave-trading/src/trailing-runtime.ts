import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { processPriceTick, type Position, type BreakevenTrailingConfig } from "./breakeven-trailing.js";
import { getTrailingStopConfig } from "./trailing-config.js";
import type { TradeExecutor } from "./trade-executor.js";

/**
 * Real gap fixed: `enableBreakevenTrailing`/`processPriceTick` (Step
 * 10.9) and `toggle_breakeven_trailing`/`process_price_tick` (Update 18)
 * were genuine logic and real tools, but nothing PERSISTED which
 * position had opted in or actually DROVE a tick on a live price update
 * -- an agent would have had to keep re-passing the whole Position
 * object on every single price move itself, forever, which never
 * actually happens. This is the missing piece: a persisted per-user,
 * per-ticket registry of opted-in positions, plus the one function that
 * turns "a new price came in" into a real `executor.modifyOrder()` call
 * when a stage fires.
 */
function registryPath(userId: string): string {
  return join(process.cwd(), "data", "trading", userId, "trailing-registry.json");
}

function readRegistry(userId: string): Record<string, Position> {
  const path = registryPath(userId);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeRegistry(userId: string, registry: Record<string, Position>): void {
  const path = registryPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(registry, null, 2), "utf8");
}

/** Registers a ticket for real, running breakeven/trailing -- throws the same way enableBreakevenTrailing does if TP1/2/3 aren't all set. */
export function registerTrailingPosition(userId: string, ticket: string, position: Omit<Position, "id">): Position {
  const full: Position = { ...position, id: ticket };
  if (full.tp1 === undefined || full.tp2 === undefined || full.tp3 === undefined) {
    throw new Error(
      "breakeven/trailing requires a position explicitly set up with TP1, TP2, AND TP3 -- this position is missing at least one, so it stays a normal single-TP trade with no automatic SL movement."
    );
  }
  const registry = readRegistry(userId);
  registry[ticket] = { ...full, breakevenTrailingEnabled: true };
  writeRegistry(userId, registry);
  return registry[ticket];
}

export function unregisterTrailingPosition(userId: string, ticket: string): boolean {
  const registry = readRegistry(userId);
  if (!(ticket in registry)) return false;
  delete registry[ticket];
  writeRegistry(userId, registry);
  return true;
}

export function listTrailingPositions(userId: string): Position[] {
  return Object.values(readRegistry(userId));
}

/**
 * The real drive loop: called with a genuinely fresh price for one
 * registered ticket. Runs the same `processPriceTick` mechanism Step
 * 10.9 built, and -- if a stage actually fires -- issues a REAL
 * `executor.modifyOrder()` so the new SL genuinely reaches the EA, not
 * just an in-memory object. Persists the updated stage flags either way
 * so a later tick doesn't re-fire an already-hit stage.
 */
export async function runTrailingTick(userId: string, ticket: string, currentPrice: number, executor: TradeExecutor): Promise<{ ranked: boolean; slChanged: boolean; newSl?: number }> {
  const registry = readRegistry(userId);
  const position = registry[ticket];
  if (!position) return { ranked: false, slChanged: false };

  const config = getTrailingStopConfig(userId);
  if (!config) return { ranked: false, slChanged: false };

  const result = processPriceTick(position, currentPrice, config);
  registry[ticket] = result.position;
  writeRegistry(userId, registry);

  if (result.slChanged) {
    await executor.modifyOrder(ticket, { sl: result.position.sl });
    return { ranked: true, slChanged: true, newSl: result.position.sl };
  }
  return { ranked: true, slChanged: false };
}
