import { NextRequest, NextResponse } from "next/server";
import { redeemPairingCode, PairingCodeInvalidError } from "../../../../server/device-auth.js";

/**
 * The app's bootstrap call, and the ONLY route under /api/app/ that does not require a device
 * token -- it is how a device gets one. It is not unprotected: the pairing code itself is the
 * credential, and it is single-use and expires in minutes (device-auth.ts).
 *
 * This is the "power up" moment the trader described: the app is given the Railway URL and a
 * code once, and from here on it holds a token and never asks again.
 */

export async function POST(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  let body: { code?: string; label?: string };
  try {
    body = (await req.json()) as { code?: string; label?: string };
  } catch {
    return NextResponse.json({ error: "Expected a JSON body with a pairing code." }, { status: 400 });
  }
  if (!body.code) return NextResponse.json({ error: "A pairing code is required." }, { status: 400 });

  try {
    const { token, device } = redeemPairingCode(userId, body.code, body.label ?? "Phone");
    return NextResponse.json({
      token,
      device: { id: device.id, label: device.label, pairedAt: device.pairedAt },
      // Said plainly because the app must store it now or lose it -- it is hashed server-side and
      // cannot be read back.
      note: "Store this token. It is shown once and cannot be recovered; pair again to get a new one.",
    });
  } catch (err) {
    if (err instanceof PairingCodeInvalidError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
}
