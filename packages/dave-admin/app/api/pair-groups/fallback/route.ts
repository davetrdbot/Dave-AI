import { NextRequest, NextResponse } from "next/server";
import { setFallbackGroup, getActiveGroupInfo } from "@dave/trading";

export async function POST(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const body = await req.json();
  setFallbackGroup(userId, body.groupId);
  return NextResponse.json({ ok: true, ...getActiveGroupInfo(userId) });
}
