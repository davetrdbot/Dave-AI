import { NextResponse } from "next/server";
import { withDevice } from "../../../../server/require-device";
import { mt5CloudAction, mt5CloudView } from "../../../../server/mt5-cloud";

/** MetaTrader 5 in Dave's own container, for the phone app's Settings. */
export const dynamic = "force-dynamic";
export const maxDuration = 400; // connect compiles the EA and starts MT5 under Wine

export const GET = withDevice(async ({ userId }) => NextResponse.json(await mt5CloudView(userId)));

export const POST = withDevice(async ({ userId, req }) => {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  return mt5CloudAction(userId, body);
});
