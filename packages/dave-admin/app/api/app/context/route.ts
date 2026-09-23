import { NextResponse } from "next/server";
import { withDevice } from "../../../../server/require-device";
import { readContextUsage } from "../../../../server/context-usage";

/**
 * Dave's context window and token use, for the phone's Context screen: the latest chat request
 * and the latest autonomous-cycle request broken into parts, plus every AI call bucketed by hour.
 *
 * `?days=N` (1-45, default 8) sets how far back the hourly buckets go. The phone groups them into
 * its own local days, so "today" means the trader's today, not the server's.
 */
export const dynamic = "force-dynamic";

export const GET = withDevice(async ({ userId, req }) => {
  const days = Math.min(Math.max(Number(req.nextUrl.searchParams.get("days")) || 8, 1), 45);
  return NextResponse.json(readContextUsage(userId, Date.now() - days * 24 * 60 * 60_000));
});
