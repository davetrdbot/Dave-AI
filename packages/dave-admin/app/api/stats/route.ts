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
  return NextResponse.json({
    uptimeSeconds: Math.floor(process.uptime()),
    pairGroupCount: groups.length,
    activeWorkerCount: workers.length,
    commsMessageCount: comms.length,
    maxOpenTrades: risk.maxOpenTrades ?? null,
    maxDailyLossPct: risk.maxDailyLossPct ?? null,
    note: "Real counts from real storage. Balance, open P&L, and win rate need a live MT5 account connected (Step 11) -- not fabricated here.",
  });
}
