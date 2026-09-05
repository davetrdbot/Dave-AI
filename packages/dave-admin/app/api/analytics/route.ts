import { NextRequest, NextResponse } from "next/server";
import { listJournalEntries } from "@dave/workers";
import { getLastKnownAccountSnapshot } from "@dave/ea-bridge";

/**
 * Real analytics data for the dashboard's balance card, heatmap, pie
 * chart, and range chart. Source of truth is the real journal store
 * (journal_trade/journal_close, now carrying a real `pnl` field) and
 * the real EA account snapshot -- no fabricated numbers. With no real
 * trades/EA connection yet, this honestly returns empty series rather
 * than inventing sample data.
 */
const PAIR_GROUP_PATTERNS: { label: string; test: (symbol: string) => boolean }[] = [
  { label: "Crypto", test: (s) => /^(BTC|ETH|SOL|XRP|LTC|BNB|DOGE)/i.test(s) },
  { label: "Synthetic", test: (s) => /^(BOOM|CRASH|VOLATILITY|STEP|JUMP)/i.test(s) },
  { label: "Metals", test: (s) => /^(XAU|XAG|XPT|XPD)/i.test(s) },
  { label: "Energies", test: (s) => /^(USOIL|UKOIL|NGAS|WTI|BRENT)/i.test(s) },
  { label: "Indexes", test: (s) => /^(US30|US500|NAS100|GER40|UK100|JPN225|SPX)/i.test(s) },
  { label: "Stocks", test: (s) => /\.(NAS|NYSE)$|^(AAPL|MSFT|TSLA|GOOGL|AMZN)/i.test(s) },
];
function classifySymbol(symbol: string): string {
  for (const { label, test } of PAIR_GROUP_PATTERNS) if (test(symbol)) return label;
  return "Forex";
}

export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const entries = listJournalEntries(userId);
  const closed = entries.filter((e) => e.closedAt !== undefined && typeof e.pnl === "number");

  // J7: heatmap -- one real day-bucket per closed trade's real close date, summed P&L.
  const dailyPnl: Record<string, number> = {};
  for (const e of closed) {
    const day = new Date(e.closedAt!).toISOString().slice(0, 10);
    dailyPnl[day] = (dailyPnl[day] ?? 0) + e.pnl!;
  }

  // J8: pie -- real trade count per real pair-group classification.
  const byGroup: Record<string, number> = {};
  for (const e of entries) {
    const label = classifySymbol(e.input.symbol);
    byGroup[label] = (byGroup[label] ?? 0) + 1;
  }

  // J9: range/band -- real per-day min/avg/max P&L across that day's closed trades (distinct from the single summed bar the heatmap shows).
  const byDayOutcomes: Record<string, number[]> = {};
  for (const e of closed) {
    const day = new Date(e.closedAt!).toISOString().slice(0, 10);
    (byDayOutcomes[day] ??= []).push(e.pnl!);
  }
  const rangeSeries = Object.entries(byDayOutcomes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, values]) => ({
      day,
      min: Math.min(...values),
      max: Math.max(...values),
      avg: Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)),
    }));

  const snapshot = getLastKnownAccountSnapshot(userId);

  return NextResponse.json({
    balance: {
      value: snapshot?.balance ?? null,
      equity: snapshot?.equity ?? null,
      updatedAt: snapshot?.updatedAt ?? null,
      note: snapshot ? null : "No EA report received yet for this user -- balance needs a real connected MT5 terminal, not fabricated here.",
    },
    heatmap: Object.entries(dailyPnl).map(([day, pnl]) => ({ day, pnl })),
    pairGroups: Object.entries(byGroup).map(([label, count]) => ({ label, count })),
    range: rangeSeries,
    totalClosedTrades: closed.length,
  });
}
