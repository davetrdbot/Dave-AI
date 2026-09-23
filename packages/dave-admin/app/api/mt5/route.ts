import { NextRequest, NextResponse } from "next/server";
import { resolveUserId } from "../../../server/owner";
import { mt5CloudAction, mt5CloudView } from "../../../server/mt5-cloud";

/** MetaTrader 5 in Dave's own container, for the web panel (behind the panel password). */
export const dynamic = "force-dynamic";
export const maxDuration = 400;

export async function GET(req: NextRequest) {
  return NextResponse.json(await mt5CloudView(resolveUserId(req.nextUrl.searchParams.get("userId"))));
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  return mt5CloudAction(resolveUserId(req.nextUrl.searchParams.get("userId")), body);
}
