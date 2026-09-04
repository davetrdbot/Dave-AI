import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Step 13: worker-to-worker AND worker-to-Dave communication. Real
 * two-way messaging -- a worker isn't limited to reporting upward
 * (that's Step 12.6's report_to_user, a different channel: worker->user
 * output). This is the internal channel: worker<->worker and
 * worker<->Dave, all persistently logged.
 *
 * "dave" is the reserved sender/recipient id representing Dave itself
 * (not a worker) -- by convention, not a special type, so the log
 * schema stays uniform for every participant.
 */
export const DAVE_PARTICIPANT_ID = "dave";

export interface CommsMessage {
  ts: number;
  from: string; // workerId or DAVE_PARTICIPANT_ID
  to: string; // workerId or DAVE_PARTICIPANT_ID
  content: string;
}

function logPath(ownerUserId: string): string {
  return join(process.cwd(), "data", "workers", ownerUserId, "comms-log.jsonl");
}

function appendLog(ownerUserId: string, message: CommsMessage): void {
  const path = logPath(ownerUserId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const line = JSON.stringify(message) + "\n";
  if (existsSync(path)) writeFileSync(path, readFileSync(path, "utf8") + line, "utf8");
  else writeFileSync(path, line, "utf8");
}

// Live subscribers per owner -- what Step 14's "Agent Teams" activity
// feed (13.3) will consume once the admin panel exists to render it.
// In-memory only: a feed subscription is a live UI session's concern,
// not something that needs to survive a restart -- the persistent log
// below is the source of truth for history.
const subscribers = new Map<string, Set<(message: CommsMessage) => void>>();

export function onMessage(ownerUserId: string, callback: (message: CommsMessage) => void): () => void {
  if (!subscribers.has(ownerUserId)) subscribers.set(ownerUserId, new Set());
  subscribers.get(ownerUserId)!.add(callback);
  return () => subscribers.get(ownerUserId)?.delete(callback);
}

/**
 * Step 13.1/13.2: send a message from one participant to another
 * (worker->worker or worker<->Dave), persisted with timestamp/sender/
 * recipient/content, and pushed to any live subscribers (13.3).
 */
export function sendMessage(ownerUserId: string, from: string, to: string, content: string): CommsMessage {
  const message: CommsMessage = { ts: Date.now(), from, to, content };
  appendLog(ownerUserId, message);
  for (const callback of subscribers.get(ownerUserId) ?? []) callback(message);
  return message;
}

/** Real persistent log, every message ever exchanged for this user's workers -- 13.2. */
export function getCommsLog(ownerUserId: string): CommsMessage[] {
  const path = logPath(ownerUserId);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const messages: CommsMessage[] = [];
  for (const line of lines) {
    try {
      messages.push(JSON.parse(line));
    } catch {
      console.error(`[dave-workers] skipping unparseable line in comms log for ${ownerUserId}`);
    }
  }
  return messages;
}

/** Every message either sent or received by one participant -- e.g. everything Dave has seen from/to workers. */
export function getConversation(ownerUserId: string, participantId: string): CommsMessage[] {
  return getCommsLog(ownerUserId).filter((m) => m.from === participantId || m.to === participantId);
}

/** Just the messages between two specific participants, in order -- a real worker<->worker or worker<->Dave thread. */
export function getThread(ownerUserId: string, participantA: string, participantB: string): CommsMessage[] {
  return getCommsLog(ownerUserId).filter(
    (m) => (m.from === participantA && m.to === participantB) || (m.from === participantB && m.to === participantA)
  );
}
