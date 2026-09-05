import { NextRequest, NextResponse } from "next/server";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { mcpList } from "@dave/mcp-manager";
import { getLovableMcpSettings } from "@dave/lovable-mcp";

/**
 * Step 14.1/11.3: MCP Connections panel -- real data, two real sources:
 *
 * 1. Generic MCP connections (dave-mcp-manager's mcpConnect/mcpList) --
 *    live sockets the agent has actually opened for this user via the
 *    mcp_connect tool (Step 11.3's generic MCP surface). Honestly
 *    in-memory only (same as mcp-manager.ts itself documents), so this
 *    genuinely reports zero until the agent process running THIS
 *    request has an open connection for the user -- not fabricated.
 * 2. The Lovable image-generation MCP connection's real configured
 *    state (dave-lovable-mcp's own settings store) -- whether a URL is
 *    configured for this user, never whether a live socket is open
 *    (that connection is opened per-request, not held open).
 *
 * No hardcoded connection list -- previously this route returned a
 * single static placeholder entry regardless of what was actually
 * configured or connected.
 */
export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";

  const generic = mcpList(userId).map((c) => ({
    name: c.serverUrl,
    kind: "generic",
    status: `connected -- ${c.tools.length} tool(s) discovered`,
  }));

  const db = new DaveDatabase(join(process.cwd(), "data", "db", `${userId}.db`));
  let lovable: { name: string; kind: string; status: string };
  try {
    const settings = getLovableMcpSettings(db, userId);
    lovable = {
      name: "Lovable image generation",
      kind: "lovable-image",
      status: settings.url ? `configured (${settings.url})` : "not configured -- set a Lovable MCP URL on the Credentials tab",
    };
  } finally {
    db.close();
  }

  return NextResponse.json({ connections: [lovable, ...generic] });
}
