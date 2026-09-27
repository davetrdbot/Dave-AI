import { createEaAnalysisSource } from "@dave/ea-bridge";
import { advanceSetup, describeSetup, getRiskSettings, listSetups, tradeExecuteWithMarginRetry, updateSetup, type TradeExecutor } from "@dave/trading";

/**
 * Drives the trader's Setups (dave-trading/setups.ts): every few seconds each active setup is
 * walked one step against the live price, cancelled when a cancel-if level is hit first, and its
 * order placed the moment the last step is met.
 */

export interface SetupSweepDeps {
  userId: string;
  executor: TradeExecutor;
  notify: (text: string) => Promise<void>;
  /** Override for tests. */
  quote?: (symbol: string) => Promise<number | undefined>;
}

const SWEEP_MS = 5_000;

async function livePrice(userId: string, symbol: string): Promise<number | undefined> {
  try {
    const q = await Promise.race([
      createEaAnalysisSource(userId).get<{ bid?: number; ask?: number; close?: number }>("price", symbol),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), 15_000).unref()),
    ]);
    if (q?.bid !== undefined && q?.ask !== undefined) return (q.bid + q.ask) / 2;
    return q?.bid ?? q?.ask ?? q?.close;
  } catch {
    return undefined;
  }
}

export async function runSetupSweep(deps: SetupSweepDeps, now = Date.now()): Promise<void> {
  const setups = listSetups(deps.userId);
  if (!setups.length) return;
  const quote = deps.quote ?? ((s: string) => livePrice(deps.userId, s));
  const prices = new Map<string, number | undefined>();
  for (const s of setups) {
    if (!prices.has(s.symbol)) prices.set(s.symbol, await quote(s.symbol));
    const price = prices.get(s.symbol);
    if (price === undefined && now < s.expiresAt) continue;
    const action = advanceSetup(s, price ?? NaN, now);
    const label = `🧩 Setup ${s.symbol}`;
    if (action.kind === "expire") {
      updateSetup(deps.userId, s.id, { status: "expired", outcome: "Expired before it triggered." });
      await deps.notify(`${label} expired without triggering: ${s.reason}`);
    } else if (action.kind === "cancel") {
      updateSetup(deps.userId, s.id, { status: "cancelled", outcome: action.why });
      await deps.notify(`${label} cancelled -- ${action.why}. (${s.reason})`);
    } else if (action.kind === "progress") {
      const hits = [...s.hits, { step: s.stage, at: now, price: price! }];
      const updated = updateSetup(deps.userId, s.id, { stage: action.stage, hits });
      await deps.notify(`${label}: step ${action.stage}/${s.steps.length} done at ${price}. ${updated ? describeSetup(updated) : ""}`);
    } else if (action.kind === "place") {
      const hits = [...s.hits, { step: s.stage, at: now, price: price! }];
      const risk = getRiskSettings(deps.userId);
      const lots = s.order.lots ?? (risk.lotMode === "on" && risk.lotValue ? risk.lotValue : 0.01);
      try {
        const placed = await tradeExecuteWithMarginRetry(deps.executor, {
          symbol: s.symbol,
          type: s.order.type,
          lots,
          price: s.order.price,
          sl: s.order.sl,
          tp: s.order.tp,
          comment: "Dave setup",
        });
        updateSetup(deps.userId, s.id, { stage: s.steps.length, hits, status: "placed", ticket: placed.ticket, outcome: `Placed #${placed.ticket}` });
        await deps.notify(`${label} triggered -- ${s.order.type.toUpperCase().replace("_", " ")} placed (#${placed.ticket}, ${lots} lots). ${s.reason}`);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        updateSetup(deps.userId, s.id, { stage: s.steps.length, hits, status: "failed", outcome: why });
        await deps.notify(`⚠️ ${label} triggered but MT5 refused the order: ${why}`);
      }
    }
  }
}

export function startSetupSweep(deps: SetupSweepDeps): NodeJS.Timeout {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void runSetupSweep(deps)
      .catch((err) => console.error(`[setups] ${deps.userId}:`, err))
      .finally(() => (busy = false));
  }, SWEEP_MS);
  timer.unref?.();
  return timer;
}
