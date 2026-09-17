import { NextRequest, NextResponse } from "next/server";
import { DaveDatabase } from "@dave/db";
import { dbPathFor } from "../../../server/db-path";
import { maskSecret } from "../../../server/mask-secret";
import { addFirecrawlKey, listFirecrawlKeys, removeFirecrawlKey, type StoredFirecrawlKey } from "@dave/firecrawl";

/** Part 3 (B1): Firecrawl key management -- real agent tools + this admin UI route, same pattern as e2b-keys/route.ts. */
function dbFor(userId: string): DaveDatabase {
  return new DaveDatabase(dbPathFor(userId));
}

/** Real bug fixed: see server/mask-secret.ts -- never send the real apiKey to the browser. */
function redact(key: StoredFirecrawlKey): StoredFirecrawlKey {
  return { ...key, apiKey: maskSecret(key.apiKey)! };
}

export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const db = dbFor(userId);
  try {
    return NextResponse.json({ keys: listFirecrawlKeys(db, userId).map(redact) });
  } finally {
    db.close();
  }
}

export async function POST(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const body = await req.json();
  const db = dbFor(userId);
  try {
    return NextResponse.json(redact(addFirecrawlKey(db, userId, body.label, body.apiKey)));
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
