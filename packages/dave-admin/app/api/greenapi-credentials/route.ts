import { NextRequest, NextResponse } from "next/server";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
// Deliberately imports the credentials-only subpath, NOT the package root --
// the root barrel re-exports green-api-voip-client.ts, which pulls in the
// native @roamhq/wrtc binding. That binding is a real .node addon Next/
// Turbopack's bundler cannot place in an ESM chunk (confirmed: "non-ecmascript
// placeable asset"), and this admin route only ever needs credential storage.
import { setGreenApiCredentials, getGreenApiCredentials } from "@dave/whatsapp-calling/greenapi-credentials";

function dbFor(userId: string): DaveDatabase {
  return new DaveDatabase(join(process.cwd(), "data", "db", `${userId}.db`));
}

export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const db = dbFor(userId);
  try {
    const creds = getGreenApiCredentials(db, userId);
    return NextResponse.json({ configured: !!creds, idInstance: creds?.idInstance });
  } finally {
    db.close();
  }
}

export async function POST(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const body = await req.json();
  const db = dbFor(userId);
  try {
    setGreenApiCredentials(db, userId, { idInstance: body.idInstance, apiTokenInstance: body.apiTokenInstance });
    return NextResponse.json({ stored: true });
  } finally {
    db.close();
  }
}
