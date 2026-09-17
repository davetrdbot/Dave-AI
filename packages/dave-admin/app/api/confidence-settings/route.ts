import { NextRequest, NextResponse } from "next/server";
import { getConfidenceSettings, setConfidenceThreshold, setAutoApproveBelowThreshold, InvalidConfidenceThresholdError } from "@dave/trading";

/**
 * Real gap fixed (the trader, live: "the bot was even ask me to approve a trade... a sniper
 * entry and a normal entry" -- confirmed by tracing autonomous-tick.ts: a trade only ever queues
 * for approval instead of firing immediately when confidence-gate.ts's `autoApproveBelowThreshold`
 * is OFF for the account, and it defaults ON. Real, most likely explanation: this setting was
 * previously only reachable through Telegram's /settings menu, buried several taps deep, with no
 * way to check its CURRENT live value without digging through that flow -- if it was ever toggled
 * off (by mistake, by an older default before "auto-approve on by default" shipped, or by the
 * model itself via a settings tool call), nothing made that easy to notice or fix. This exposes
 * it directly in the admin panel: real current value, one toggle, no digging.
 */
export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  return NextResponse.json(getConfidenceSettings(userId));
}

export async function POST(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const body = (await req.json()) as { threshold?: number; autoApproveBelowThreshold?: boolean };
  try {
    if (body.threshold !== undefined) setConfidenceThreshold(userId, body.threshold);
    if (body.autoApproveBelowThreshold !== undefined) setAutoApproveBelowThreshold(userId, body.autoApproveBelowThreshold);
    return NextResponse.json({ ok: true, ...getConfidenceSettings(userId) });
  } catch (err) {
    if (err instanceof InvalidConfidenceThresholdError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 400 });
    }
    throw err;
  }
}
