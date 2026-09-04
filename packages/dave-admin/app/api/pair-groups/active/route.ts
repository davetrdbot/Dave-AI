import { NextRequest, NextResponse } from "next/server";
import { setActiveGroup, getActiveGroupInfo } from "@dave/trading";

export async function POST(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const body = await req.json();
  setActiveGroup(userId, body.groupId);
  return NextResponse.json({ ok: true, ...getActiveGroupInfo(userId) });
}
