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
export function middleware(req: NextRequest): NextResponse {
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
