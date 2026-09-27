import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { verifyDeviceToken } from "@dave/db";
import { DEFAULT_MT5_AGENT_URL } from "@dave/ea-bridge";

/**
 * The MT5 container's screen, live, with mouse and keyboard -- "like a VPS" in the app. The MT5
 * container runs a VNC server on its virtual screen and noVNC (a browser viewer) on port 6080 of
 * Railway's private network; this relays /mt5-screen/* to it, WebSocket included.
 *
 * Nothing is reachable without a paired device: the first request carries the device token
 * (?token=), which is swapped for a short-lived signed cookie so the viewer's own requests (its
 * files and the WebSocket) are let through. The token is never passed on to the container.
 */

export const MT5_SCREEN_PREFIX = "/mt5-screen/";
const COOKIE = "dave_mt5_screen";
const COOKIE_TTL_MS = 12 * 60 * 60_000;
const SCREEN_PORT = Number(process.env.MT5_SCREEN_PORT) || 6080;

function target(): { host: string; port: number } {
  const url = new URL(process.env.MT5_AGENT_URL?.trim() || DEFAULT_MT5_AGENT_URL);
  return { host: url.hostname, port: SCREEN_PORT };
}

export interface Mt5ScreenProxy {
  handle(req: IncomingMessage, res: ServerResponse): void;
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
}

export function createMt5ScreenProxy(userId: string, secret = randomBytes(32), screen = target()): Mt5ScreenProxy {
  const sign = (expires: number) => createHmac("sha256", secret).update(`${userId}:${expires}`).digest("base64url");

  function cookieOk(req: IncomingMessage): boolean {
    const raw = (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
    if (!raw) return false;
    const [expires, sig] = raw.slice(COOKIE.length + 1).split(".");
    const exp = Number(expires);
    if (!exp || exp < Date.now() || !sig) return false;
    const want = Buffer.from(sign(exp));
    const got = Buffer.from(sig);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://local");
    const token = url.searchParams.get("token");
    if (token) {
      if (!verifyDeviceToken(userId, token)) return deny(res);
      const exp = Date.now() + COOKIE_TTL_MS;
      url.searchParams.delete("token");
      res.writeHead(302, {
        location: url.pathname + url.search,
        "set-cookie": `${COOKIE}=${exp}.${sign(exp)}; Path=${MT5_SCREEN_PREFIX}; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_TTL_MS / 1000}`,
        "cache-control": "no-store",
      });
      res.end();
      return;
    }
    if (!cookieOk(req)) return deny(res);
    const headers = { ...req.headers, host: `${screen.host}:${screen.port}` };
    delete headers.cookie;
    const upstream = httpRequest(
      { host: screen.host, port: screen.port, method: req.method, path: stripPrefix(req.url ?? "/"), headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end("The MT5 screen isn't reachable. Is the MT5 service running (and updated to the build with the screen)?");
      } else res.end();
    });
    req.pipe(upstream);
  }

  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!cookieOk(req)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    const up = connect(screen.port, screen.host, () => {
      const headers = { ...req.headers, host: `${screen.host}:${screen.port}` };
      delete headers.cookie;
      const lines = [`${req.method} ${stripPrefix(req.url ?? "/")} HTTP/1.1`];
      for (const [k, v] of Object.entries(headers)) if (v !== undefined) for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`);
      up.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    const close = () => {
      up.destroy();
      socket.destroy();
    };
    up.on("error", close);
    socket.on("error", close);
    up.on("close", close);
    socket.on("close", close);
  }

  return { handle, upgrade };
}

function stripPrefix(url: string): string {
  const rest = url.slice(MT5_SCREEN_PREFIX.length - 1);
  return rest.startsWith("/") ? rest : `/${rest}`;
}

function deny(res: ServerResponse): void {
  res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
  res.end("Open the MT5 screen from the Dave app (Settings -> MetaTrader 5 -> Screen).");
}
