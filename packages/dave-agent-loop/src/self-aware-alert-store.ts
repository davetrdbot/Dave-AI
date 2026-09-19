import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Edge-trigger memory for the proactive self-aware SL alert (see self-aware-sweep.ts).
 *
 * The owner's upgrade request was: "when a trade is reaching 50% toward the SL it should alert."
 * The one hard requirement that comes with any level-based alert in this codebase is that it fires
 * ONCE per crossing, never on every sweep -- this repo has already been bitten by repeat-alert
 * notifications ("the bot is disturbing me"), which is exactly why background-watch.ts is
 * edge-triggered by construction. This is that same edge-trigger, but for a position's live
 * SL-progress instead of a marked price level: it records, per real MT5 ticket, that a
 * "crossed 50% toward SL" alert has already gone out, so the sweep can ask "has this one already
 * fired?" and stay silent if so.
 *
 * File-backed under DAVE_DATA_ROOT, exactly like background-watch.ts, for one deliberate reason:
 * the alert should not re-fire on every process restart while a position sits parked past 50% for
 * hours. A restart re-alerting a single time is acceptable (the spec says so); re-alerting every
 * 30s sweep is the real bug this store exists to prevent, and only durable state prevents that.
 *
 * When a ticket disappears from the live EA snapshot (the position closed), its record is cleared
 * (reconcileOpenTickets) so a FUTURE trade on a brand-new ticket can alert again -- MT5 tickets are
 * unique per position, but clearing also keeps this store from growing without bound.
 */

/** The whole store for a user: the set of tickets whose "crossed 50%" alert has already been sent.
 *  Stored as a map to a timestamp purely for human-debuggability of the JSON; only the KEY matters. */
type AlertedTickets = Record<string, number>;

function storePath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "self-aware-sl-alerts.json");
}

function readStore(userId: string): AlertedTickets {
  const path = storePath(userId);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as AlertedTickets) : {};
  } catch {
    // A corrupt store must never take down the sweep timer (which shares a process with the
    // trading loop). Worst case one crossing re-alerts, which is strictly better than throwing.
    return {};
  }
}

function writeStore(userId: string, store: AlertedTickets): void {
  const path = storePath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2), "utf8");
}

/** Has this ticket's "crossed 50% toward SL" alert already been sent? */
export function hasAlerted(userId: string, ticket: string): boolean {
  return Object.prototype.hasOwnProperty.call(readStore(userId), ticket);
}

/**
 * Records that this ticket's crossing alert is being sent, and returns true ONLY if this call is
 * the one that claimed it. Edge-triggered by construction: a second call for the same ticket
 * returns false and writes nothing, so two overlapping sweeps can never double-alert on one
 * crossing -- the exact same guarantee markWatchTriggered gives background-watch.ts.
 */
export function markAlerted(userId: string, ticket: string): boolean {
  const store = readStore(userId);
  if (Object.prototype.hasOwnProperty.call(store, ticket)) return false;
  store[ticket] = Date.now();
  writeStore(userId, store);
  return true;
}

/** Explicitly forget one ticket -- so a future trade on it (a recycled ticket) can alert again. */
export function clearAlert(userId: string, ticket: string): void {
  const store = readStore(userId);
  if (!Object.prototype.hasOwnProperty.call(store, ticket)) return;
  delete store[ticket];
  writeStore(userId, store);
}

/**
 * Drops the record for every ticket that is no longer in the live open-position snapshot -- i.e.
 * the position closed. This is what lets a NEW trade (a new ticket) on the same symbol alert again
 * later, and keeps the store from accumulating dead tickets forever. Returns the tickets it cleared.
 */
export function reconcileOpenTickets(userId: string, openTickets: readonly string[]): string[] {
  const store = readStore(userId);
  const open = new Set(openTickets);
  const cleared: string[] = [];
  for (const ticket of Object.keys(store)) {
    if (!open.has(ticket)) {
      delete store[ticket];
      cleared.push(ticket);
    }
  }
  if (cleared.length > 0) writeStore(userId, store);
  return cleared;
}

/** Test/introspection helper: the tickets currently recorded as already-alerted. */
export function listAlertedTickets(userId: string): string[] {
  return Object.keys(readStore(userId));
}
