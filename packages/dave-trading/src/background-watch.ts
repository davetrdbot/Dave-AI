import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

/**
 * Real feature (the trader, explicit): "add a feature similar like your background tool like the
 * way you run your background script -- the bot will use that for anything it want to check, like
 * to mark key level and to check if price will reach so so level or a direction... and when the
 * script is returning back it should come back with the reason made earlier why it mark or do
 * that, and also add a tool to check like his pending script the way you normally do, and also
 * stop it, and expand the background script so it can check for anything."
 *
 * So: a real background-check system Dave drives itself, modelled on how a coding agent runs
 * background tasks -- start one, list what is still pending, cancel one -- with three properties
 * the trader called out specifically:
 *
 *  1. Every watch carries Dave's OWN stated reason, and that reason is REQUIRED at creation. A
 *     watch that fires hours later is useless if the thesis behind it is gone, so the reason is
 *     part of the record and comes back with the trigger, verbatim.
 *  2. Edge-triggered. A level is crossed once; it must alert once and then be done, never re-fire
 *     on every subsequent price tick. This codebase has already been bitten by level-triggered
 *     notifications ("the bot is disturbing me"), so that is designed in rather than patched on.
 *  3. Deliberately mechanical conditions. The EA reports prices, and a price comparison is exact,
 *     cheap and evaluable hundreds of times an hour without a model call. An arbitrary
 *     natural-language condition would need a full LLM turn on every heartbeat to judge -- so the
 *     cheap mechanical trigger is what watches for the level, and Dave's own reason is what tells
 *     him (and the trader) what to reassess once it fires. Expanding the KINDS is a one-line
 *     addition to the union and evaluateWatch below.
 */

export type WatchKind = "price_at_or_above" | "price_at_or_below";

export type WatchStatus = "active" | "triggered" | "cancelled";

export interface BackgroundWatch {
  id: string;
  symbol: string;
  kind: WatchKind;
  level: number;
  /** Dave's own reason for marking this. Required, and returned with the trigger. */
  reason: string;
  createdAt: number;
  status: WatchStatus;
  triggeredAt?: number;
  triggeredPrice?: number;
}

/** Each active watch costs a real EA price round trip per evaluation sweep, so the count is
 *  bounded -- an unbounded list would quietly starve the trading loop it shares an EA with. */
export const MAX_ACTIVE_WATCHES = 20;

export class TooManyActiveWatchesError extends Error {
  constructor(limit: number) {
    super(`You already have ${limit} active background checks -- cancel one with cancel_watch before adding another.`);
    this.name = "TooManyActiveWatchesError";
  }
}

export class WatchReasonRequiredError extends Error {
  constructor() {
    super(
      "A background check needs your own real reason for setting it (what you marked, and why it matters). " +
        "That reason is handed back to you when it fires, which is the whole point -- a level that triggers hours " +
        "later is useless without the thesis behind it."
    );
    this.name = "WatchReasonRequiredError";
  }
}

export class InvalidWatchLevelError extends Error {
  constructor(level: number) {
    super(`A background check needs a real positive price level -- got ${level}.`);
    this.name = "InvalidWatchLevelError";
  }
}

export class WatchNotFoundError extends Error {
  constructor(id: string) {
    super(`No background check with id ${id}.`);
    this.name = "WatchNotFoundError";
  }
}

function watchesPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "background-watches.json");
}

function readWatches(userId: string): BackgroundWatch[] {
  const path = watchesPath(userId);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? (parsed as BackgroundWatch[]) : [];
  } catch {
    // A corrupt store must never take down a trading cycle -- this process has genuinely crashed
    // mid-write before. Worst case a watch is lost, which is strictly better than throwing here.
    return [];
  }
}

function writeWatches(userId: string, watches: BackgroundWatch[]): void {
  const path = watchesPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(watches, null, 2), "utf8");
}

export function createWatch(
  userId: string,
  input: { symbol: string; kind: WatchKind; level: number; reason: string }
): BackgroundWatch {
  if (!input.reason || input.reason.trim().length === 0) throw new WatchReasonRequiredError();
  if (!Number.isFinite(input.level) || input.level <= 0) throw new InvalidWatchLevelError(input.level);
  const watches = readWatches(userId);
  if (watches.filter((w) => w.status === "active").length >= MAX_ACTIVE_WATCHES) {
    throw new TooManyActiveWatchesError(MAX_ACTIVE_WATCHES);
  }
  const watch: BackgroundWatch = {
    id: randomBytes(4).toString("hex"),
    symbol: input.symbol,
    kind: input.kind,
    level: input.level,
    reason: input.reason.trim(),
    createdAt: Date.now(),
    status: "active",
  };
  writeWatches(userId, [...watches, watch]);
  return watch;
}

/** Still pending -- what "check my background scripts" should show. */
export function listActiveWatches(userId: string): BackgroundWatch[] {
  return readWatches(userId).filter((w) => w.status === "active");
}

export function listAllWatches(userId: string): BackgroundWatch[] {
  return readWatches(userId);
}

export function cancelWatch(userId: string, id: string): BackgroundWatch {
  const watches = readWatches(userId);
  const watch = watches.find((w) => w.id === id);
  if (!watch) throw new WatchNotFoundError(id);
  watch.status = "cancelled";
  writeWatches(userId, watches);
  return watch;
}

/**
 * Pure, so it is genuinely testable without a filesystem or an EA: has this watch's condition
 * been met at this price?
 */
export function evaluateWatch(watch: BackgroundWatch, price: number): boolean {
  if (!Number.isFinite(price) || price <= 0) return false;
  if (watch.status !== "active") return false;
  return watch.kind === "price_at_or_above" ? price >= watch.level : price <= watch.level;
}

/**
 * Marks a watch triggered and returns it. Edge-triggered by construction: the status flips off
 * "active" here, so the next sweep cannot fire it again no matter how long price sits past the
 * level. Returns undefined if it was already triggered or cancelled, so a caller racing two
 * sweeps still only ever alerts once.
 */
export function markWatchTriggered(userId: string, id: string, price: number): BackgroundWatch | undefined {
  const watches = readWatches(userId);
  const watch = watches.find((w) => w.id === id);
  if (!watch || watch.status !== "active") return undefined;
  watch.status = "triggered";
  watch.triggeredAt = Date.now();
  watch.triggeredPrice = price;
  writeWatches(userId, watches);
  return watch;
}

/** The distinct symbols worth fetching a price for this sweep -- so N watches on one symbol cost
 *  one EA round trip, not N. */
export function symbolsToPoll(userId: string): string[] {
  return [...new Set(listActiveWatches(userId).map((w) => w.symbol))];
}

/**
 * The alert text. Dave's own reason is reproduced verbatim and prominently, because the trader's
 * whole stated requirement was that a firing watch comes back with "the reason made earlier why
 * it mark or do that".
 */
export function buildWatchTriggeredMessage(watch: BackgroundWatch): string {
  const direction = watch.kind === "price_at_or_above" ? "reached or passed above" : "reached or dropped below";
  const age = watch.triggeredAt !== undefined ? Math.round((watch.triggeredAt - watch.createdAt) / 60_000) : undefined;
  const waited = age === undefined ? "" : age < 1 ? " (set less than a minute ago)" : ` (set ${age}m ago)`;
  return (
    `🔔 ${watch.symbol} ${direction} ${watch.level} — now ${watch.triggeredPrice}${waited}.\n\n` +
    `📌 Why I marked it: ${watch.reason}`
  );
}
