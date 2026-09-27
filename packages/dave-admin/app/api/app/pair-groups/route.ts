import { NextResponse } from "next/server";
import { deleteGroup, getActiveGroupInfo, listGroups, setActiveGroup, setFallbackGroup, upsertGroup } from "@dave/trading";
import { withDevice } from "../../../../server/require-device";

/**
 * Pair groups for the phone: which symbols Dave hunts. Create, edit, delete, and pick the active
 * and fallback group -- the same store the web panel and Telegram's /groups use.
 */
export const dynamic = "force-dynamic";

function view(userId: string) {
  const info = getActiveGroupInfo(userId);
  return {
    groups: listGroups(userId),
    activeGroupId: info.activeGroup?.id ?? null,
    fallbackGroupId: info.fallbackGroup?.id ?? null,
  };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || `group-${Date.now()}`;

export const GET = withDevice(async ({ userId }) => NextResponse.json(view(userId)));

export const POST = withDevice(async ({ userId, req }) => {
  let body: { action?: string; id?: string; name?: string; symbols?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  try {
    switch (body.action) {
      case "save": {
        const name = String(body.name ?? "").trim();
        const raw = Array.isArray(body.symbols) ? body.symbols : String(body.symbols ?? "").split(/[\s,]+/);
        const symbols = [...new Set(raw.map((s) => String(s).trim()).filter(Boolean))];
        if (!name) return NextResponse.json({ error: "Give the group a name." }, { status: 400 });
        if (!symbols.length) return NextResponse.json({ error: "Add at least one symbol." }, { status: 400 });
        upsertGroup(userId, { id: body.id || slug(name), name, symbols });
        break;
      }
      case "delete":
        deleteGroup(userId, String(body.id ?? ""));
        break;
      case "activate":
        setActiveGroup(userId, String(body.id ?? ""));
        break;
      case "fallback":
        setFallbackGroup(userId, String(body.id ?? ""));
        break;
      default:
        return NextResponse.json({ error: "action must be save, delete, activate or fallback." }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
  return NextResponse.json(view(userId));
});
