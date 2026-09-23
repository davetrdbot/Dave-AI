import { NextRequest, NextResponse } from "next/server";
import { createPairingCode, listDevices, revokeDevice, PAIRING_CODE_TTL_MS } from "../../../server/device-auth";

/**
 * The WEB PANEL side of device pairing -- deliberately NOT under /api/app/, because this is the
 * trusted surface that mints the credential, and it sits behind the panel's existing Basic Auth.
 * If this were reachable with a device token, a stolen phone could mint access for another one.
 *
 * GET  -> the devices already paired (never their tokens, which are not stored in recoverable form)
 * POST -> mint a fresh pairing code to type into the app
 * DELETE ?deviceId= -> revoke one device, leaving every other one working
 */

export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  return NextResponse.json({ devices: listDevices(userId) });
}

export async function POST(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const { code, expiresAt } = createPairingCode(userId);
  return NextResponse.json({
    code,
    expiresAt,
    ttlMinutes: Math.round(PAIRING_CODE_TTL_MS / 60_000),
    note: "Single use. Type it into the app along with this deployment's URL.",
  });
}

export async function DELETE(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const deviceId = req.nextUrl.searchParams.get("deviceId");
  if (!deviceId) return NextResponse.json({ error: "deviceId is required" }, { status: 400 });
  const revoked = revokeDevice(userId, deviceId);
  if (!revoked) return NextResponse.json({ error: "No such device." }, { status: 404 });
  return NextResponse.json({ ok: true, revoked: deviceId });
}
