import { NextRequest, NextResponse } from "next/server";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { getLovableMcpSettings, setLovableMcpSettings } from "@dave/lovable-mcp";

/**
 * Update 5: "Settings fields: 'Lovable MCP URL' and 'Lovable MCP
 * Token', user enters own values, nothing hardcoded ... UI must
 * support updating it anytime." Token is never echoed back in full on
 * GET -- only whether one is set, so it isn't re-displayed in plaintext
 * every time the settings page loads.
 */
export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const db = new DaveDatabase(join(process.cwd(), "data", "db", `${userId}.db`));
  try {
    const settings = getLovableMcpSettings(db, userId);
    return NextResponse.json({ url: settings.url, tokenSet: Boolean(settings.token) });
  } finally {
    db.close();
  }
}

export async function POST(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const body = await req.json();
  const db = new DaveDatabase(join(process.cwd(), "data", "db", `${userId}.db`));
  try {
    setLovableMcpSettings(db, userId, { url: body.url ?? null, token: body.token ?? null });
    const settings = getLovableMcpSettings(db, userId);
    return NextResponse.json({ ok: true, url: settings.url, tokenSet: Boolean(settings.token) });
  } finally {
    db.close();
  }
}
