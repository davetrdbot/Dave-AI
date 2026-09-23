import { NextRequest, NextResponse } from "next/server";
import { verifyDeviceToken } from "./device-auth";

/**
 * The route-level half of device auth for everything under `/api/app/*`.
 *
 * Why it lives here and not in middleware, which is where it belongs on paper: this project runs
 * Next 16.3.4, whose `MiddlewareConfigInput` has no `runtime` field -- checked against the
 * installed type definition, not assumed. Middleware is therefore Edge-only, and the Edge runtime
 * has no `node:fs`, so it cannot read the paired-device file to verify anything. Middleware does
 * the cheap Edge-safe part (reject a request to a device route that carries no bearer token at
 * all) and this does the real check.
 *
 * That split leaves one obvious way to get it wrong -- a new route under `/api/app/` that simply
 * forgets to wrap itself, and is then open to anyone who sends the word "Bearer". That is not
 * guarded by care; it is guarded by step155, which reads every route file under that directory
 * and fails if one does not use this wrapper.
 */

export const DEVICE_API_PREFIX = "/api/app/";

export interface DeviceContext {
  userId: string;
  req: NextRequest;
}

function bearerToken(req: NextRequest): string | undefined {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return undefined;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : undefined;
}

/**
 * Wraps a device-API handler. The userId comes from the query string exactly as it does on every
 * other route in this panel; the token is what proves the caller may act as that user at all.
 */
export function withDevice(handler: (ctx: DeviceContext) => Promise<NextResponse> | NextResponse) {
  return async (req: NextRequest): Promise<NextResponse> => {
    const token = bearerToken(req);
    const userId = req.nextUrl.searchParams.get("userId") ?? "default";
    if (!token || !verifyDeviceToken(userId, token)) {
      // Deliberately identical for a missing, malformed, unknown and revoked token: telling the
      // caller which one it was is free information for anyone probing.
      return NextResponse.json({ error: "unpaired", message: "This device is not paired. Pair it again from the web panel." }, { status: 401 });
    }
    return handler({ userId, req });
  };
}
