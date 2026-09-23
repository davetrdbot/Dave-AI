import { NextResponse } from "next/server";
import { readTradeEventsAfter, latestTradeEventId } from "@dave/ea-bridge";
import { withDevice } from "../../../../server/require-device";

/**
 * Trade open/close events for the phone -- the server half of push WITHOUT Firebase.
 *
 * Researched before building (the trader asked for it explicitly). The options that avoid FCM on
 * Android are: (a) UnifiedPush, which needs the trader to install a separate distributor app such
 * as ntfy, or whose "embedded" mode routes through Google Play services -- i.e. FCM again; and
 * (b) the app holding its OWN connection open from a foreground service. (b) needs nothing
 * installed and no third party, which is what "put the endpoint in and it powers up" asks for.
 * This route is the other end of that connection.
 *
 * Two formats from one route:
 *   - `text/event-stream` (default): Server-Sent Events. The Flutter foreground service holds this
 *     open and raises a local notification per event. Standard SSE `id:` lines mean a reconnect
 *     sends Last-Event-ID and resumes exactly where it left off.
 *   - `?format=json&after=N`: a one-shot catch-up. When Android has killed the service anyway (it
 *     happens -- Doze, aggressive OEM battery managers), the app calls this on next launch so a
 *     fill that happened while it was dead still arrives, late rather than never.
 *
 * A fresh connection with no Last-Event-ID starts at "now", not at the beginning of the log --
 * otherwise pairing a phone would greet it with a burst of notifications for old trades.
 */

export const dynamic = "force-dynamic";

/** How often the log is checked for new events. Trades are minutes apart; 2s is effectively live. */
const POLL_MS = 2_000;
/** SSE comment heartbeat. Proxies (Railway's included) drop idle connections; this also lets the
 *  app detect a dead socket rather than trusting a connection that silently stopped delivering. */
const HEARTBEAT_MS = 25_000;
/** Tells the client how long to wait before reconnecting after a drop. */
const RETRY_MS = 5_000;

function parseId(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

export const GET = withDevice(async ({ userId, req }) => {
  const params = req.nextUrl.searchParams;
  const resumeFrom = parseId(req.headers.get("last-event-id")) ?? parseId(params.get("after"));

  if (params.get("format") === "json") {
    const after = resumeFrom ?? 0;
    const events = readTradeEventsAfter(userId, after);
    return NextResponse.json({ events, latestId: events.length > 0 ? events[events.length - 1].id : latestTradeEventId(userId) });
  }

  let lastId = resumeFrom ?? latestTradeEventId(userId);
  const encoder = new TextEncoder();
  let poll: ReturnType<typeof setInterval> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // The client went away between checks -- cleanup happens in cancel()/abort below.
        }
      };

      send(`retry: ${RETRY_MS}\n\n`);
      // Tells the app which id "now" is, so it can persist a resume point even before any trade.
      send(`event: ready\ndata: ${JSON.stringify({ latestId: lastId })}\n\n`);

      const flush = () => {
        let events;
        try {
          events = readTradeEventsAfter(userId, lastId);
        } catch {
          return; // a half-written file is retried on the next tick, never surfaced as an error
        }
        for (const e of events) {
          send(`id: ${e.id}\nevent: trade\ndata: ${JSON.stringify(e)}\n\n`);
          lastId = e.id;
        }
      };
      flush(); // anything already waiting after a Last-Event-ID resume goes out immediately
      poll = setInterval(flush, POLL_MS);
      heartbeat = setInterval(() => send(`: ping ${Date.now()}\n\n`), HEARTBEAT_MS);

      const stop = () => {
        clearInterval(poll);
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener("abort", stop, { once: true });
    },
    cancel() {
      clearInterval(poll);
      clearInterval(heartbeat);
    },
  });

  return new NextResponse(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Stops nginx-style proxies buffering the stream into silence.
      "x-accel-buffering": "no",
    },
  });
});
