import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EaPosition, EaClosedPosition } from "./ea-webhook.js";

/**
 * A durable, numbered log of trade opens and closes -- the source for the mobile app's push
 * notifications.
 *
 * Why a log and not an in-process event emitter: the bot writes it, but the thing that streams it
 * to the phone is the admin panel, which is a SEPARATE process (documented across this codebase;
 * see trading-loop.ts and provider-router.ts). An emitter in the bot is invisible to the admin. A
 * file both can see is the convention every other cross-process value here already follows.
 *
 * Why numbered: the app's connection WILL drop -- mobile networks, Doze, a killed service. On
 * reconnect it sends the last id it saw (SSE's own Last-Event-ID) and gets everything after it,
 * so a fill that happened while the phone was offline is delivered late rather than lost.
 *
 * It also closes a real gap. ea-bridge.ts's handleReport detected CLOSES (TP/SL, manual, Dave's
 * own) but had no notion of an OPEN at all -- a trade opened by hand in the MT5 terminal was never
 * reported to anyone. Opens are detected here from the same before/after position diff.
 */

export type TradeEvent =
  | {
      id: number;
      at: number;
      type: "opened";
      ticket: string;
      symbol: string;
      side: "buy" | "sell";
      lots: number;
      openPrice: number;
      sl?: number;
      tp?: number;
    }
  | {
      id: number;
      at: number;
      type: "closed";
      ticket: string;
      symbol: string;
      /** Realised P&L when the EA reported it; the last known floating P&L otherwise. */
      pnl?: number;
      reason: EaClosedPosition["reason"];
    };

type NewTradeEvent = TradeEvent extends infer E ? (E extends TradeEvent ? Omit<E, "id" | "at"> : never) : never;

interface TradeEventLog {
  nextId: number;
  events: TradeEvent[];
}

/** Enough to cover a phone offline for days of normal trading, small enough to rewrite whole. */
export const TRADE_EVENT_LOG_CAP = 500;

export function tradeEventLogPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trade-events", userId, "events.json");
}

function readLog(userId: string): TradeEventLog {
  const path = tradeEventLogPath(userId);
  if (!existsSync(path)) return { nextId: 1, events: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<TradeEventLog>;
    const events = Array.isArray(parsed.events) ? parsed.events : [];
    // nextId must never go backwards, even if the file was hand-edited or truncated: a reused id
    // would be silently skipped by any app already past it.
    const maxSeen = events.reduce((m, e) => Math.max(m, e.id), 0);
    return { nextId: Math.max(parsed.nextId ?? 1, maxSeen + 1), events };
  } catch {
    return { nextId: 1, events: [] };
  }
}

function writeLog(userId: string, log: TradeEventLog): void {
  const path = tradeEventLogPath(userId);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(log), "utf8");
}

/** Appends events, skipping any (type, ticket) pair already in the log -- so a replayed or
 *  repeated report can never notify the same open or close twice. The log IS the dedup store,
 *  which keeps this independent of the Telegram close-dedup and correct across restarts. */
export function appendTradeEvents(userId: string, incoming: NewTradeEvent[], now = Date.now()): TradeEvent[] {
  if (incoming.length === 0) return [];
  const log = readLog(userId);
  const seen = new Set(log.events.map((e) => `${e.type}:${e.ticket}`));
  const added: TradeEvent[] = [];
  for (const e of incoming) {
    const key = `${e.type}:${e.ticket}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const event = { ...e, id: log.nextId++, at: now } as TradeEvent;
    log.events.push(event);
    added.push(event);
  }
  if (added.length === 0) return [];
  if (log.events.length > TRADE_EVENT_LOG_CAP) log.events = log.events.slice(-TRADE_EVENT_LOG_CAP);
  writeLog(userId, log);
  return added;
}

/** Everything after `afterId`, oldest first. */
export function readTradeEventsAfter(userId: string, afterId: number): TradeEvent[] {
  return readLog(userId).events.filter((e) => e.id > afterId);
}

/** The newest id, so a FRESH connection can start from "now" instead of replaying history as a
 *  burst of stale notifications. */
export function latestTradeEventId(userId: string): number {
  const events = readLog(userId).events;
  return events.length > 0 ? events[events.length - 1].id : 0;
}

/**
 * Derives the open/close events for one EA report from the before/after position lists.
 *
 * `isFirstReport` matters: the very first report a user ever sends has no previous state, so
 * every position already open in the terminal would look newly opened. That would greet a
 * freshly paired phone with a burst of "opened" notifications for trades that are hours old.
 */
export function deriveTradeEvents(input: {
  previous: EaPosition[];
  current: EaPosition[];
  closedPositions: EaClosedPosition[];
  daveClosed: Set<string>;
  isFirstReport: boolean;
}): NewTradeEvent[] {
  const out: NewTradeEvent[] = [];
  const prevTickets = new Set(input.previous.map((p) => p.ticket));
  const currTickets = new Set(input.current.map((p) => p.ticket));

  if (!input.isFirstReport) {
    for (const p of input.current) {
      if (prevTickets.has(p.ticket)) continue;
      out.push({ type: "opened", ticket: p.ticket, symbol: p.symbol, side: p.type, lots: p.lots, openPrice: p.openPrice, sl: p.sl, tp: p.tp });
    }
  }

  // Closes the EA reported explicitly carry the real realised P&L and reason -- prefer them.
  const reported = new Map(input.closedPositions.map((c) => [c.ticket, c]));
  for (const c of input.closedPositions) {
    out.push({ type: "closed", ticket: c.ticket, symbol: c.symbol, pnl: c.pnl, reason: c.reason });
  }
  // Positions that simply vanished without an explicit close report.
  for (const p of input.previous) {
    if (currTickets.has(p.ticket) || reported.has(p.ticket)) continue;
    out.push({ type: "closed", ticket: p.ticket, symbol: p.symbol, pnl: p.pnl, reason: input.daveClosed.has(p.ticket) ? "dave" : "manual" });
  }
  return out;
}
