import { NextRequest, NextResponse } from "next/server";
import { getEaConnectionStatus } from "@dave/ea-bridge";

/**
 * Item 5 real gap fixed (DAVEMA retirement): this used to ping the retired external DAVEMA API
 * on every admin dashboard load. The real market-data dependency is the connected MT5 EA now,
 * not an HTTP API -- this reports the real thing Dave actually depends on.
 */
export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const status = getEaConnectionStatus(userId);
  return NextResponse.json(status);
}
