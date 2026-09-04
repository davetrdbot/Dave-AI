import { NextRequest, NextResponse } from "next/server";
import { listWorkers, getCommsLog } from "@dave/workers";

/** Step 14.1/13.3: Agent Teams view -- powered directly by Step 13's real comms log. */
export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  return NextResponse.json({ workers: listWorkers(userId), feed: getCommsLog(userId) });
}
