import { NextResponse } from "next/server";
import { ownerUserId } from "../../../server/owner";

/**
 * Which user the bot actually runs as, so the web panel's user box can start there.
 *
 * The panel always sends an explicit userId (its box defaulted to the literal "default"), and an
 * explicit id always wins. On a deployment with OWNER_USER_ID set, that meant every tab -- the
 * dashboard, settings, and the new phone pairing -- quietly operated on a user the bot never
 * writes to. Pairing was where it would have surfaced: a code minted for "default" is rejected by
 * a phone redeeming it for the real owner.
 */
export async function GET() {
  return NextResponse.json({ ownerUserId: ownerUserId() });
}
