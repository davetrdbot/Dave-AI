import { createEaAnalysisSource, getLastKnownState } from "@dave/ea-bridge";
import { advanceScalpCycle, listScalpCycles, saveScalpCycles, tradeExecuteWithMarginRetry, type ScalpCycle, type TradeExecutor } from "@dave/trading";

/**
 * Drives the pullback scalp cycles (scalp-cycle.ts): bank $20, go in again when price comes back to
 * the entry, close for good at the limit. Reads MT5 from the EA's own reports; asks the EA for a
 * price only while a cycle is waiting for re-entry.
 */

export interface ScalpSweepDeps {
  userId: string;
  executor: TradeExecutor;
  notify: (text: string) => Promise<void>;
  /** Overrides for tests. */
  eaState?: () => ReturnType<typeof getLastKnownState>;
  quote?: (symbol: string, side: "buy" | "sell") => Promise<number | undefined>;
}

const SWEEP_MS = 5_000;

async function livePrice(userId: string, symbol: string, side: "buy" | "sell"): Promise<number | undefined> {
  try {
    const q = await Promise.race([
      createEaAnalysisSource(userId).get<{ bid?: number; ask?: number; close?: number }>("price", symbol),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), 15_000).unref()),
    ]);
    return side === "buy" ? (q?.ask ?? q?.close) : (q?.bid ?? q?.close);
  } catch {
    return undefined;
  }
}

export async function runScalpCycleSweep(deps: ScalpSweepDeps, now = Date.now()): Promise<void> {
  const cycles = listScalpCycles(deps.userId);
  if (!cycles.length) return;
  const state = deps.eaState ? deps.eaState() : getLastKnownState(deps.userId);
  const keep: ScalpCycle[] = [];
  for (const c of cycles) {
    const pos = c.ticket ? state.positions.find((p) => p.ticket === c.ticket) : undefined;
    const limitPending = state.pendingOrders.some((o) => o.ticket === c.limitTicket);
    const price = c.phase === "wait" ? await (deps.quote ?? ((s, side) => livePrice(deps.userId, s, side)))(c.symbol, c.side) : undefined;
    const action = advanceScalpCycle(c, { position: pos, limitPending, price }, now);
    const label = `${c.symbol} ${c.side.toUpperCase()} scalp`;
    try {
      if (action.kind === "take") {
        await deps.executor.closePosition(action.ticket);
        c.phase = "wait";
        c.ticket = undefined;
        c.rounds += 1;
        c.banked += action.pnl;
        await deps.notify(`💵 ${label}: +$${action.pnl.toFixed(2)} banked (round ${c.rounds}, $${c.banked.toFixed(2)} so far). Going in again if price comes back to ${c.entry}.`);
      } else if (action.kind === "reenter") {
        const placed = await tradeExecuteWithMarginRetry(deps.executor, { symbol: c.symbol, type: c.side, lots: c.lots, sl: c.sl, tp: c.limitPrice, comment: "Dave pullback" });
        c.phase = "open";
        c.ticket = placed.ticket;
        c.openedAt = now;
        await deps.notify(`🔁 ${label}: price is back at ${c.entry} -- in again (#${placed.ticket}), aiming for another $20 or the limit at ${c.limitPrice}.`);
      } else if (action.kind === "finish") {
        if (action.closeTicket) await deps.executor.closePosition(action.closeTicket).catch(() => undefined);
        await deps.notify(`🏁 ${label} done: ${action.reason}. ${c.rounds} round${c.rounds === 1 ? "" : "s"}, $${c.banked.toFixed(2)} banked.`);
        continue; // cycle over
      }
    } catch (err) {
      await deps.notify(`⚠️ ${label}: MT5 refused (${err instanceof Error ? err.message : String(err)}) -- trying again shortly.`).catch(() => undefined);
    }
    keep.push(c);
  }
  // A cycle registered while this sweep ran must survive the write-back.
  const latest = listScalpCycles(deps.userId);
  const known = new Set(cycles.map((c) => c.id));
  saveScalpCycles(deps.userId, [...keep, ...latest.filter((c) => !known.has(c.id))]);
}

export function startScalpCycleSweep(deps: ScalpSweepDeps): NodeJS.Timeout {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void runScalpCycleSweep(deps)
      .catch((err) => console.error(`[scalp-cycle] ${deps.userId}:`, err))
      .finally(() => (busy = false));
  }, SWEEP_MS);
  timer.unref?.();
  return timer;
}
