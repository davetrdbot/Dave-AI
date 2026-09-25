import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * One live feed of what Dave is doing, for the app's Chat and Live screens: chat turns (a message
 * in, each tool starting and finishing, thinking, the reply), the autonomous loop (cycles, analysis,
 * thoughts, decisions, Flo, orders) and background work (Nous, scalps, alerts, trades).
 *
 * Kept in memory for instant delivery and appended to data/agent-loop/<uid>/activity.jsonl so the
 * app can catch up after a restart or a reconnect (ids only ever increase). The file is trimmed to
 * the most recent events now and then, so it never grows without bound.
 */

export type ActivityFeed = "chat" | "loop" | "background";
export type ActivityChannel = "app" | "telegram";

export interface ActivityEvent {
  id: number;
  at: number;
  feed: ActivityFeed;
  /** e.g. user_message, turn_start, tool_start, tool_end, thinking, text, final, ask_user, error,
   *  message, cycle_start, cycle_skip, thought, decision, flo, order, nous_signal, scalp, alert... */
  kind: string;
  /** Groups a chat turn's events together. */
  turnId?: string;
  channel?: ActivityChannel;
  /** Who produced it when it isn't Dave himself: "worker:<name>", "flo", "journal". */
  agent?: string;
  data: Record<string, unknown>;
}

const RING = 500;
const FILE_KEEP = 1500;
const TRIM_EVERY = 250;
/** Tool results can be huge (a full analysis); the feed carries a readable slice. */
export const MAX_FIELD_CHARS = 4000;

interface UserBus {
  nextId: number;
  ring: ActivityEvent[];
  listeners: Set<(e: ActivityEvent) => void>;
  appendsSinceTrim: number;
}
const buses = new Map<string, UserBus>();

function filePath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "agent-loop", userId, "activity.jsonl");
}

function load(userId: string): UserBus {
  const existing = buses.get(userId);
  if (existing) return existing;
  const bus: UserBus = { nextId: 1, ring: [], listeners: new Set(), appendsSinceTrim: 0 };
  const path = filePath(userId);
  if (existsSync(path)) {
    const events: ActivityEvent[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as ActivityEvent);
      } catch {
        /* a torn last line after a crash -- skip it */
      }
    }
    bus.ring = events.slice(-RING);
    bus.nextId = (events.at(-1)?.id ?? 0) + 1;
  }
  buses.set(userId, bus);
  return bus;
}

/** Shortens long strings anywhere in a value so one event stays small. */
export function clip(value: unknown, max = MAX_FIELD_CHARS, depth = 0): unknown {
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}… (${value.length - max} more characters)` : value;
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => clip(v, max, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = clip(v, max, depth + 1);
  return out;
}

export function publishActivity(
  userId: string,
  feed: ActivityFeed,
  kind: string,
  data: Record<string, unknown> = {},
  extra: { turnId?: string; channel?: ActivityChannel; agent?: string } = {},
): ActivityEvent {
  const bus = load(userId);
  const event: ActivityEvent = { id: bus.nextId++, at: Date.now(), feed, kind, ...extra, data: clip(data) as Record<string, unknown> };
  bus.ring.push(event);
  if (bus.ring.length > RING) bus.ring.splice(0, bus.ring.length - RING);
  try {
    const path = filePath(userId);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
    if (++bus.appendsSinceTrim >= TRIM_EVERY) {
      bus.appendsSinceTrim = 0;
      const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
      if (lines.length > FILE_KEEP) writeFileSync(path, `${lines.slice(-FILE_KEEP).join("\n")}\n`, "utf8");
    }
  } catch (err) {
    console.error(`[activity] couldn't persist event for ${userId}:`, err);
  }
  for (const listener of bus.listeners) {
    try {
      listener(event);
    } catch {
      /* a broken listener never stops the others */
    }
  }
  return event;
}

/** Events after `afterId`, oldest first (from memory, then the file for older history). */
export function activityAfter(userId: string, afterId: number, feeds?: ActivityFeed[], limit = RING): ActivityEvent[] {
  const bus = load(userId);
  let pool = bus.ring;
  if (bus.ring.length && bus.ring[0].id > afterId + 1 && existsSync(filePath(userId))) {
    pool = readFileSync(filePath(userId), "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as ActivityEvent;
        } catch {
          return undefined;
        }
      })
      .filter((e): e is ActivityEvent => !!e);
  }
  return pool.filter((e) => e.id > afterId && (!feeds || feeds.includes(e.feed))).slice(-limit);
}

export function latestActivityId(userId: string): number {
  return load(userId).nextId - 1;
}

export function subscribeActivity(userId: string, listener: (e: ActivityEvent) => void): () => void {
  const bus = load(userId);
  bus.listeners.add(listener);
  return () => bus.listeners.delete(listener);
}

/** Tests only. */
export function resetActivityBusForTests(): void {
  buses.clear();
}
