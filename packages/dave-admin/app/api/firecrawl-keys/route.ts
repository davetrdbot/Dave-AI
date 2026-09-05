import { NextRequest, NextResponse } from "next/server";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { addFirecrawlKey, listFirecrawlKeys, removeFirecrawlKey } from "@dave/firecrawl";

/** Part 3 (B1): Firecrawl key management -- real agent tools + this admin UI route, same pattern as e2b-keys/route.ts. */
function dbFor(userId: string): DaveDatabase {
  return new DaveDatabase(join(process.cwd(), "data", "db", `${userId}.db`));
}

export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const db = dbFor(userId);
  try {
    return NextResponse.json({ keys: listFirecrawlKeys(db, userId) });
  } finally {
    db.close();
  }
}

export async function POST(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const body = await req.json();
  const db = dbFor(userId);
  try {
    return NextResponse.json(addFirecrawlKey(db, userId, body.label, body.apiKey));
  } finally {
    db.close();
  }
}

export async function DELETE(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const keyId = req.nextUrl.searchParams.get("keyId");
  if (!keyId) return NextResponse.json({ error: "keyId required" }, { status: 400 });
  const db = dbFor(userId);
  try {
    return NextResponse.json({ removed: removeFirecrawlKey(db, userId, keyId) });
  } finally {
    db.close();
  }
}
