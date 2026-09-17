import { NextRequest, NextResponse } from "next/server";
import { DaveDatabase } from "@dave/db";
import { dbPathFor } from "../../../server/db-path";
import { maskSecret } from "../../../server/mask-secret";
import { addE2BKey, listE2BKeys, removeE2BKey, checkE2BKeyHealth, type StoredE2BKey } from "@dave/e2b";

/** Update 17 (settings audit): E2B key management had real agent tools (Update 12) but no admin UI route. */
function dbFor(userId: string): DaveDatabase {
  return new DaveDatabase(dbPathFor(userId));
}

/** Real bug fixed: see server/mask-secret.ts -- never send the real apiKey to the browser. */
function redact(key: StoredE2BKey): StoredE2BKey {
  return { ...key, apiKey: maskSecret(key.apiKey)! };
}

export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const db = dbFor(userId);
  try {
    return NextResponse.json({ keys: listE2BKeys(db, userId).map(redact) });
  } finally {
    db.close();
  }
}

export async function POST(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const body = await req.json();
  const db = dbFor(userId);
  try {
    if (body.checkHealth) {
      const key = listE2BKeys(db, userId).find((k) => k.id === body.keyId);
      if (!key) return NextResponse.json({ error: "not found" }, { status: 404 });
      return NextResponse.json({ healthy: await checkE2BKeyHealth(db, userId, key) });
    }
    return NextResponse.json(redact(addE2BKey(db, userId, body.label, body.apiKey)));
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
    return NextResponse.json({ removed: removeE2BKey(db, userId, keyId) });
  } finally {
    db.close();
  }
}
