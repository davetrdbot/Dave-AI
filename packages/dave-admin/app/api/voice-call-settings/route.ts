import { NextRequest, NextResponse } from "next/server";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { getVoiceCallSettings, setVoiceCallSettings } from "@dave/voice-call";

/**
 * Update 6: "Settings fields: Green API Token, Green API Instance ID,
 * user's own WhatsApp number with country code." Token is never echoed
 * back in full on GET, same posture as Update 5's Lovable MCP token.
 */
export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const db = new DaveDatabase(join(process.cwd(), "data", "db", `${userId}.db`));
  try {
    const settings = getVoiceCallSettings(db, userId);
    return NextResponse.json({ ...settings, greenApiToken: undefined, tokenSet: Boolean(settings.greenApiToken) });
  } finally {
    db.close();
  }
}

export async function POST(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const body = await req.json();
  const db = new DaveDatabase(join(process.cwd(), "data", "db", `${userId}.db`));
  try {
    const settings = setVoiceCallSettings(db, userId, body);
    return NextResponse.json({ ok: true, ...settings, greenApiToken: undefined, tokenSet: Boolean(settings.greenApiToken) });
  } finally {
    db.close();
  }
}
