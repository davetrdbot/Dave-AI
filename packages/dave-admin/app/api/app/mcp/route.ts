import { NextResponse } from "next/server";
import { DaveDatabase } from "@dave/db";
import { addMcpServerConfig, listMcpServerConfigs, mcpList, removeMcpServerConfig } from "@dave/mcp-manager";
import { getLovableMcpSettings, setLovableMcpSettings } from "@dave/lovable-mcp";
import { dbPathFor } from "../../../../server/db-path";
import { withDevice } from "../../../../server/require-device";

/**
 * MCP servers for the phone: the saved servers Dave can connect to (same store as Telegram's /mcp
 * and the mcp_connect_saved tool), and the Lovable image MCP. Tokens go in once and never come back.
 */
export const dynamic = "force-dynamic";

function view(userId: string) {
  const live = new Set(mcpList(userId).map((c) => c.serverUrl));
  const db = new DaveDatabase(dbPathFor(userId));
  let lovable: { url: string | null; tokenSet: boolean };
  try {
    const s = getLovableMcpSettings(db, userId);
    lovable = { url: s.url ?? null, tokenSet: Boolean(s.token) };
  } finally {
    db.close();
  }
  return {
    servers: listMcpServerConfigs(userId).map((c) => ({ id: c.id, name: c.name, url: c.url, hasToken: Boolean(c.token), connected: live.has(c.url) })),
    lovable,
  };
}

export const GET = withDevice(async ({ userId }) => NextResponse.json(view(userId)));

export const POST = withDevice(async ({ userId, req }) => {
  let body: { action?: string; id?: string; name?: string; url?: string; token?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  try {
    switch (body.action) {
      case "add": {
        const url = String(body.url ?? "").trim();
        if (!/^https?:\/\//i.test(url)) return NextResponse.json({ error: "The server address must start with http:// or https://" }, { status: 400 });
        const name = String(body.name ?? "").trim() || new URL(url).hostname;
        addMcpServerConfig(userId, name, url, String(body.token ?? "").trim() || undefined);
        break;
      }
      case "remove":
        removeMcpServerConfig(userId, String(body.id ?? ""));
        break;
      case "lovable": {
        const db = new DaveDatabase(dbPathFor(userId));
        try {
          const current = getLovableMcpSettings(db, userId);
          setLovableMcpSettings(db, userId, {
            url: body.url !== undefined ? String(body.url).trim() || null : (current.url ?? null),
            token: body.token !== undefined ? String(body.token).trim() || null : (current.token ?? null),
          });
        } finally {
          db.close();
        }
        break;
      }
      default:
        return NextResponse.json({ error: "action must be add, remove or lovable." }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
  return NextResponse.json(view(userId));
});
