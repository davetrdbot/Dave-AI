import { NextRequest, NextResponse } from "next/server";
import { listGroups, upsertGroup, getActiveGroupInfo } from "@dave/trading";

function getUserId(req: NextRequest): string {
  return req.nextUrl.searchParams.get("userId") ?? "default";
}

/**
 * Step 14.1: the pair group designer. Reads/writes THROUGH dave-trading's
 * own storage functions -- this is what makes "the designer's output is
 * what Step 10 actually reads" true by construction, not by convention.
 */
export async function GET(req: NextRequest) {
  const userId = getUserId(req);
  return NextResponse.json({ groups: listGroups(userId), ...getActiveGroupInfo(userId) });
}

export async function POST(req: NextRequest) {
  const userId = getUserId(req);
  const body = await req.json();
  if (!body.id || !body.name || !Array.isArray(body.symbols)) {
    return NextResponse.json({ error: "id, name, and symbols[] are required" }, { status: 400 });
  }
  upsertGroup(userId, { id: body.id, name: body.name, symbols: body.symbols });
  return NextResponse.json({ ok: true, groups: listGroups(userId) });
}
