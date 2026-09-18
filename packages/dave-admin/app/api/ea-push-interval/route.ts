import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NextRequest, NextResponse } from "next/server";

/**
 * Real gap fixed (the trader, live: "I told you change it to 1 min"). Dave's EA heartbeat/push
 * interval (set_push_interval, see @dave/ea-bridge's setEaPushInterval) was previously only
 * reachable through Telegram's /connection flow -- no admin panel control existed, even though
 * this is the exact same "real UI control" pattern already used for the trading-loop interval
 * (see ../trading-loop/route.ts's own comment on why this file is self-contained rather than
 * importing @dave/ea-bridge's full barrel). Same shared-file convention: this writes the SAME
 * command-queue.json and push-interval-preference.json files setEaPushInterval() would, so the
 * live bot process picks it up identically on the EA's next poll -- no restart needed.
 */
function queuePath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "ea-bridge", userId, "command-queue.json");
}

function pushIntervalPreferencePath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "ea-bridge", userId, "push-interval-preference.json");
}

function writeJson(path: string, value: unknown): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

const MIN_SECONDS = 1;
const MAX_SECONDS = 300;

export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  return NextResponse.json({
    // The last value asked for -- see setEaPushInterval's own real round-trip note: the EA only
    // actually applies this on its NEXT poll, so this can briefly be ahead of what's live.
    lastRequestedSeconds: readJson<number | undefined>(pushIntervalPreferencePath(userId), undefined),
    min: MIN_SECONDS,
    max: MAX_SECONDS,
  });
}

export async function POST(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const body = (await req.json()) as { seconds?: number };
  const seconds = body.seconds;
  if (seconds === undefined || !Number.isInteger(seconds) || seconds < MIN_SECONDS || seconds > MAX_SECONDS) {
    return NextResponse.json({ ok: false, error: `EA push interval must be a whole number of seconds between ${MIN_SECONDS} and ${MAX_SECONDS} (got ${seconds}).` }, { status: 400 });
  }
  const queue = readJson<Array<Record<string, unknown>>>(queuePath(userId), []);
  queue.push({ id: randomUUID(), action: "set_push_interval", seconds });
  writeJson(queuePath(userId), queue);
  writeJson(pushIntervalPreferencePath(userId), seconds);
  return NextResponse.json({ ok: true, requestedSeconds: seconds });
}
