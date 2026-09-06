import { NextRequest, NextResponse } from "next/server";
import { DaveDatabase } from "@dave/db";
import { dbPathFor } from "../../../server/db-path";
import { addProviderKey, editProviderKey, removeProviderKey, listProviderKeys, checkProviderKeyHealth, type ProviderName } from "@dave/brain";

/** Update 4: admin UI's key-CRUD surface, mirroring provider-tools.ts's agent tools. */
function dbFor(userId: string): DaveDatabase {
  return new DaveDatabase(dbPathFor(userId));
}

export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const provider = req.nextUrl.searchParams.get("provider") as ProviderName | null;
  const db = dbFor(userId);
  try {
    return NextResponse.json({ keys: listProviderKeys(db, userId, provider ?? undefined) });
  } finally {
    db.close();
  }
}

export async function POST(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const body = await req.json();
  const db = dbFor(userId);
  try {
    if (body.keyId) {
      const updated = editProviderKey(db, userId, body.keyId, { label: body.label, config: body.config });
      if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });
      return NextResponse.json(updated);
    }
    if (body.checkHealth) {
      const keys = listProviderKeys(db, userId, body.provider);
      const target = keys.find((k) => k.id === body.checkKeyId);
      if (!target) return NextResponse.json({ error: "not found" }, { status: 404 });
      const healthy = await checkProviderKeyHealth(db, userId, target);
      return NextResponse.json({ healthy });
    }
    const created = addProviderKey(db, userId, body.provider, body.label, body.config);
    return NextResponse.json(created);
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
    return NextResponse.json({ removed: removeProviderKey(db, userId, keyId) });
  } finally {
    db.close();
  }
}
