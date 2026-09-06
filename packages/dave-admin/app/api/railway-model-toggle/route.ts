import { NextRequest, NextResponse } from "next/server";
import { DaveDatabase } from "@dave/db";
import { dbPathFor } from "../../../server/db-path";
import { getRailwayModelLoadEnabled, setRailwayModelLoadEnabled } from "@dave/brain";

/**
 * Item 2: "Load Model on Railway" toggle -- real DB-backed state
 * (same per-user `data/db/<userId>.db` convention Steps 16/17 already
 * use), defaults off.
 */
export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const db = new DaveDatabase(dbPathFor(userId));
  try {
    return NextResponse.json({ enabled: getRailwayModelLoadEnabled(db, userId) });
  } finally {
    db.close();
  }
}

export async function POST(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const body = await req.json();
  const db = new DaveDatabase(dbPathFor(userId));
  try {
    setRailwayModelLoadEnabled(db, userId, Boolean(body.enabled));
    return NextResponse.json({ ok: true, enabled: getRailwayModelLoadEnabled(db, userId) });
  } finally {
    db.close();
  }
}
