import { NextResponse } from "next/server";
import { withDevice } from "../../../../server/require-device";
import { listAppProviders, moveBackup, resolveAppProvider } from "../../../../server/app-providers";

/**
 * Every AI provider Dave can use, for the phone's Providers list: which one is main, the backups
 * in the order he falls back to them, and how many keys each has. Per-provider management (keys,
 * model, main/backup) lives at /api/app/provider?provider=<id>.
 */
export const dynamic = "force-dynamic";

export const GET = withDevice(async ({ userId }) => NextResponse.json(listAppProviders(userId)));

/** { action: "move-backup", provider, direction: "up" | "down" } */
export const POST = withDevice(async ({ userId, req }) => {
  let body: { action?: string; provider?: string; direction?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  if (body.action !== "move-backup") return NextResponse.json({ error: "action must be move-backup." }, { status: 400 });
  const provider = resolveAppProvider(body.provider);
  if (!provider || !body.provider) return NextResponse.json({ error: "Unknown provider." }, { status: 404 });
  if (body.direction !== "up" && body.direction !== "down") return NextResponse.json({ error: "direction must be up or down." }, { status: 400 });
  moveBackup(userId, provider, body.direction);
  return NextResponse.json(listAppProviders(userId));
});
