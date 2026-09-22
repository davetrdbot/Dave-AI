import { NextResponse, type NextRequest } from "next/server";

/**
 * Real gap fixed (Railway pre-deployment check, Part A item 3): the
 * admin panel -- credential management, trading settings, provider
 * keys -- had zero access control. Deployed publicly on Railway with no
 * auth, anyone with the URL could read/change all of it. Real HTTP
 * Basic Auth, gated by ADMIN_USERNAME/ADMIN_PASSWORD (see .env.example).
 *
 * Honest about the gap this doesn't close: if neither env var is set,
 * auth is skipped entirely (fails open) rather than locking out local
 * dev/testing with no way in -- production deploys MUST set both.
 */
/** The mobile app's own API surface. Authenticated by per-device bearer token, not Basic Auth --
 *  see server/require-device.ts for why the real check cannot happen here. */
const DEVICE_API_PREFIX = "/api/app/";
/** The one device route that must work BEFORE a device has a token: redeeming a pairing code.
 *  It is protected by the code itself, which is single-use and short-lived (device-auth.ts). */
const DEVICE_PAIR_ROUTE = "/api/app/pair";

export function middleware(req: NextRequest): NextResponse {
  const path = req.nextUrl.pathname;

  // Device API: exempt from Basic Auth, because an app cannot answer a browser's Basic Auth
  // prompt and storing the panel password on a phone is exactly what per-device tokens avoid.
  // This is only the Edge-safe shape check -- a request with no bearer token at all is rejected
  // here so it never reaches a route; whether the token is REAL is decided by withDevice(), which
  // can read the paired-device file. Both run; neither is sufficient alone.
  if (path.startsWith(DEVICE_API_PREFIX)) {
    if (path === DEVICE_PAIR_ROUTE) return NextResponse.next();
    const auth = req.headers.get("authorization");
    if (auth?.startsWith("Bearer ") && auth.slice("Bearer ".length).trim().length > 0) return NextResponse.next();
    return NextResponse.json({ error: "unpaired", message: "This device is not paired. Pair it again from the web panel." }, { status: 401 });
  }

  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) return NextResponse.next();

  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Basic ")) {
    const decoded = Buffer.from(auth.slice("Basic ".length), "base64").toString("utf8");
    const separatorIndex = decoded.indexOf(":");
    const user = separatorIndex >= 0 ? decoded.slice(0, separatorIndex) : decoded;
    const pass = separatorIndex >= 0 ? decoded.slice(separatorIndex + 1) : "";
    if (user === username && pass === password) return NextResponse.next();
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Dave Admin"' },
  });
}

export const config = {
  matcher: "/((?!_next/static|_next/image|favicon.ico).*)",
};
