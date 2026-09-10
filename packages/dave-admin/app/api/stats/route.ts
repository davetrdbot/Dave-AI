import { NextRequest, NextResponse } from "next/server";
import { listGroups, getRiskSettings } from "@dave/trading";
import { listWorkers, getCommsLog } from "@dave/workers";

/**
 * Step 14.1: live stats. Real counts from the same storage Steps 4/10/
 * 12/13 already built -- no separate admin data layer.
 */
export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const groups = listGroups(userId);
  const workers = listWorkers(userId);
  const comms = getCommsLog(userId);
  const risk = getRiskSettings(userId);
  // Real gap fixed (user, live: "it's showing 0 workers in /stats... it's not analyzing any
  // [expletive] thing"): activeWorkerCount only ever counts a worker still marked active --
  // Setup Panel specialists (item 7) are deliberately ephemeral, retired the instant each one
  // reports, so this genuinely reads 0 almost all the time EVEN WHILE the panel is actively
  // running -- "0 active workers" was never evidence of "nothing happening." The real, durable
  // signal is the persisted comms log (survives retirement) -- this surfaces recent Setup Panel
  // activity from it directly, so the panel running is visible even between/after runs.
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const recentPanelMessages = comms.filter((m) => m.to.startsWith("panel:") && m.ts >= oneDayAgo);
  const lastPanelMessage = comms.filter((m) => m.to.startsWith("panel:")).sort((a, b) => b.ts - a.ts)[0];
  return NextResponse.json({
    uptimeSeconds: Math.floor(process.uptime()),
    pairGroupCount: groups.length,
    activeWorkerCount: workers.length,
    commsMessageCount: comms.length,
    setupPanelMessagesLast24h: recentPanelMessages.length,
    setupPanelLastActiveAt: lastPanelMessage?.ts ?? null,
    maxOpenTrades: risk.maxOpenTrades ?? null,
    maxDailyLossPct: risk.maxDailyLossPct ?? null,
    note: "Real counts from real storage. activeWorkerCount is near-always 0 by design -- Setup Panel specialists are ephemeral and retire immediately after reporting; use setupPanelMessagesLast24h/setupPanelLastActiveAt for real evidence of recent panel activity instead. Balance, open P&L, and win rate need a live MT5 account connected (Step 11) -- not fabricated here.",
  });
}
