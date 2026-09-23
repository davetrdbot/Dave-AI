import { NextResponse } from "next/server";
import { getLastKnownAccountSnapshot, getLastKnownState, getEaConnectionStatus, readClosedTradeHistory } from "@dave/ea-bridge";
import { listJournalEntries } from "@dave/workers";
import { getRiskSettings } from "@dave/trading";
import { withDevice } from "../../../../server/require-device";

/**
 * Everything the app's home screen needs, in ONE call.
 *
 * Deliberately one endpoint rather than the five the web panel uses: a phone on mobile data pays
 * a full round trip per request, and the home screen is useless until all of it has arrived. The
 * web panel can afford to fan out; the app should not.
 *
 * The genuinely new piece here is `open` -- ONGOING trades. The data has been sitting in the EA
 * bridge's last-known state file the whole time (getLastKnownState), but nothing ever exposed it:
 * /api/analytics only ever reported CLOSED trades, so the admin panel could show you the history
 * of your trading and not what was open right now.
 *
 * Nothing here is fabricated. With no EA connected, balance is null and the lists are empty, and
 * the response says which -- the same discipline /api/analytics already holds to.
 */

const DAY_MS = 86_400_000;
/** A year of daily buckets, which is what a GitHub-style heatmap shows. */
const HEATMAP_DAYS = 365;

/** Plenty for a year of active trading; keeps the payload bounded if a strategy trades very often. */
const MAX_TRADES_RETURNED = 3000;

interface ClosedTrade {
  ticket?: string;
  symbol: string;
  side?: "buy" | "sell";
  pnl: number;
  closedAt: number;
}

/**
 * Every closed trade with a known result, oldest first.
 *
 * Two sources, because each misses what the other has:
 *   - the EA's close history: every close MT5 reported, by any route (TP, SL, Dave, by hand), with
 *     the real realised P&L. It only starts from when that history began being kept.
 *   - Dave's journal: only trades Dave journalled AND explicitly closed, but it goes back further.
 * The EA record wins for any ticket both have.
 */
function closedTrades(userId: string): ClosedTrade[] {
  const fromEa: ClosedTrade[] = readClosedTradeHistory(userId)
    .filter((r) => typeof r.pnl === "number")
    .map((r) => ({ ticket: r.ticket, symbol: r.symbol, side: r.side, pnl: r.pnl!, closedAt: r.closedAt }));
  const tickets = new Set(fromEa.map((t) => t.ticket));
  const fromJournal: ClosedTrade[] = listJournalEntries(userId)
    .filter((e) => e.closedAt !== undefined && typeof e.pnl === "number" && !(e.input.ticket && tickets.has(String(e.input.ticket))))
    .map((e) => ({ ticket: e.input.ticket ? String(e.input.ticket) : undefined, symbol: e.input.symbol, side: e.input.direction, pnl: e.pnl!, closedAt: e.closedAt! }));
  return [...fromEa, ...fromJournal].sort((a, b) => a.closedAt - b.closedAt);
}

function dayKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export const GET = withDevice(async ({ userId }) => {
  const snapshot = getLastKnownAccountSnapshot(userId);
  const { positions, pendingOrders } = getLastKnownState(userId);
  const ea = getEaConnectionStatus(userId);
  const risk = getRiskSettings(userId);

  const closed = closedTrades(userId);

  // Heatmap: one bucket per day, summed P&L, over a fixed trailing window so the grid is a
  // stable shape the app can render without first measuring the data.
  const since = Date.now() - HEATMAP_DAYS * DAY_MS;
  const dailyPnl: Record<string, { pnl: number; trades: number }> = {};
  for (const e of closed) {
    if (e.closedAt < since) continue;
    const day = dayKey(e.closedAt);
    const bucket = (dailyPnl[day] ??= { pnl: 0, trades: 0 });
    bucket.pnl += e.pnl;
    bucket.trades += 1;
  }

  const wins = closed.filter((e) => e.pnl > 0).length;
  const realisedPnl = closed.reduce((sum, e) => sum + e.pnl, 0);

  return NextResponse.json({
    account: {
      balance: snapshot?.balance ?? null,
      equity: snapshot?.equity ?? null,
      margin: snapshot?.margin ?? null,
      freeMargin: snapshot?.freeMargin ?? null,
      leverage: snapshot?.leverage ?? null,
      updatedAt: snapshot?.updatedAt ?? null,
    },
    ea: { connected: ea.connected, lastSeenAt: ea.lastSeenAt, secondsSinceLastSeen: ea.secondsSinceLastSeen },
    open: {
      positions,
      pendingOrders,
      count: positions.length,
      maxOpenTrades: risk.maxOpenTrades ?? null,
    },
    results: {
      closedTrades: closed.length,
      wins,
      losses: closed.length - wins,
      winRatePercent: closed.length > 0 ? Math.round((wins / closed.length) * 100) : null,
      realisedPnl: Number(realisedPnl.toFixed(2)),
    },
    heatmap: {
      days: HEATMAP_DAYS,
      buckets: Object.entries(dailyPnl)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, v]) => ({ day, pnl: Number(v.pnl.toFixed(2)), trades: v.trades })),
    },
    // Every closed trade in the window, oldest first. The app builds its range views (1 day to
    // 1 year), the P&L chart and the hourly heatmap from these in the phone's own time zone --
    // the day buckets above are UTC days, which is the wrong midnight for most traders.
    trades: closed
      .filter((e) => e.closedAt >= since)
      .slice(-MAX_TRADES_RETURNED)
      .map((e) => ({ at: e.closedAt, pnl: Number(e.pnl.toFixed(2)), symbol: e.symbol, side: e.side ?? null })),
    // Honest about an empty dashboard, so the app can show a real reason rather than zeros that
    // look like losses.
    emptyReason: snapshot ? null : "No EA report received yet -- connect the MT5 terminal to see a real balance.",
  });
});
