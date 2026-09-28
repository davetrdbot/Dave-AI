import { NextResponse } from "next/server";
import { readClosedTradeHistory } from "@dave/ea-bridge";
import { listJournalEntries } from "@dave/workers";
import { withDevice } from "../../../../server/require-device";

/**
 * Dave's full trade history for any period (the trader: "the full bot trade history in the app,
 * with a custom period button and a graph"). ?from=&to= in epoch ms; both optional (all time).
 *
 * Same two sources as the dashboard: the EA's close record (every close, real P&L, how it closed)
 * and Dave's journal (older trades, and why he opened each one). The EA record wins per ticket.
 */
export const dynamic = "force-dynamic";

const MAX_ROWS = 3000;

export const GET = withDevice(async ({ userId, req }) => {
  const q = req.nextUrl.searchParams;
  const from = Number(q.get("from") ?? 0) || 0;
  const to = Number(q.get("to") ?? 0) || Date.now() + 60_000;
  if (from > to) return NextResponse.json({ error: "from must be before to." }, { status: 400 });

  const journal = listJournalEntries(userId);
  const why = new Map<string, { reason: string; entry?: number; sl?: number; tp?: number }>();
  for (const e of journal) {
    if (e.input.ticket) why.set(String(e.input.ticket), { reason: (e.input.reasoning ?? []).join("; ").slice(0, 500), entry: e.input.entryPrice, sl: e.input.sl, tp: e.input.tp });
  }
  const fromEa = readClosedTradeHistory(userId)
    .filter((r) => typeof r.pnl === "number")
    .map((r) => ({ ticket: r.ticket, symbol: r.symbol, side: r.side ?? null, pnl: r.pnl as number, closedAt: r.closedAt, closedBy: r.reason ?? null }));
  const tickets = new Set(fromEa.map((t) => t.ticket));
  const fromJournal = journal
    .filter((e) => e.closedAt !== undefined && typeof e.pnl === "number" && !(e.input.ticket && tickets.has(String(e.input.ticket))))
    .map((e) => ({ ticket: e.input.ticket ? String(e.input.ticket) : null, symbol: e.input.symbol, side: e.input.direction ?? null, pnl: e.pnl as number, closedAt: e.closedAt as number, closedBy: null as string | null }));
  const all = [...fromEa, ...fromJournal].sort((a, b) => a.closedAt - b.closedAt);
  const inRange = all.filter((t) => t.closedAt >= from && t.closedAt <= to);

  const wins = inRange.filter((t) => t.pnl > 0);
  const losses = inRange.filter((t) => t.pnl < 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.pnl, 0);
  const bySymbol = new Map<string, { trades: number; pnl: number; wins: number }>();
  for (const t of inRange) {
    const b = bySymbol.get(t.symbol) ?? { trades: 0, pnl: 0, wins: 0 };
    b.trades++;
    b.pnl += t.pnl;
    if (t.pnl > 0) b.wins++;
    bySymbol.set(t.symbol, b);
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return NextResponse.json({
    from,
    to,
    earliest: all[0]?.closedAt ?? null,
    summary: {
      trades: inRange.length,
      wins: wins.length,
      losses: losses.length,
      winRatePercent: inRange.length ? Math.round((wins.length / inRange.length) * 100) : null,
      netPnl: r2(grossWin - grossLoss),
      profitFactor: grossLoss > 0 ? r2(grossWin / grossLoss) : null,
      bestTrade: inRange.length ? r2(Math.max(...inRange.map((t) => t.pnl))) : null,
      worstTrade: inRange.length ? r2(Math.min(...inRange.map((t) => t.pnl))) : null,
      avgWin: wins.length ? r2(grossWin / wins.length) : null,
      avgLoss: losses.length ? r2(-grossLoss / losses.length) : null,
    },
    bySymbol: [...bySymbol.entries()].map(([symbol, v]) => ({ symbol, trades: v.trades, pnl: r2(v.pnl), winRatePercent: Math.round((v.wins / v.trades) * 100) })).sort((a, b) => b.pnl - a.pnl),
    trades: inRange
      .slice(-MAX_ROWS)
      .map((t) => ({ ...t, pnl: r2(t.pnl), ...(t.ticket && why.has(t.ticket) ? { why: why.get(t.ticket) } : {}) })),
    truncated: inRange.length > MAX_ROWS,
  });
});
