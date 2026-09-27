import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OrderType } from "./order-types.js";

/**
 * Setups -- a trade plan written as "if the market goes this way, then comes this way, place the
 * trade; if it goes that way instead, don't" (the trader's own words). Dave writes them with the
 * setup_create tool (or the trader asks him to); a sweep in the bot walks every active setup
 * through its steps against the live price and places the order the moment the last step is met.
 *
 *   steps    -- conditions that must happen IN ORDER: "price goes above 2660", then "price comes
 *               back below 2650". Each only starts counting once the one before it has happened.
 *   cancelIf -- conditions that kill the setup at any point before it fires: "price goes below
 *               2640 first" = the idea is wrong, don't place.
 *   order    -- what to place when the last step is met: market or pending, with its SL and TP.
 *
 * Pure decisions (advanceSetup) plus a small store; the timer that drives it lives in the bot.
 */

export type SetupOp = "above" | "below";

export interface SetupCondition {
  /** "above": price at or above `price`. "below": price at or below it. */
  op: SetupOp;
  price: number;
  /** Optional words for the trader ("sweeps the Asian high"). */
  note?: string;
}

export type SetupStatus = "active" | "placed" | "cancelled" | "expired" | "failed";

export interface Setup {
  id: string;
  symbol: string;
  /** The plan in plain words, shown to the trader and handed back to Dave when it fires. */
  reason: string;
  steps: SetupCondition[];
  cancelIf: SetupCondition[];
  order: { type: OrderType; lots?: number; price?: number; sl?: number; tp?: number };
  /** How many steps have happened so far. */
  stage: number;
  status: SetupStatus;
  createdAt: number;
  expiresAt: number;
  /** When each step was met, and the price it was met at. */
  hits: { step: number; at: number; price: number }[];
  /** Why it ended (placed ticket, which cancel condition, the error...). */
  outcome?: string;
  ticket?: string;
}

export const DEFAULT_SETUP_HOURS = 24;
export const MAX_SETUP_HOURS = 24 * 7;
export const MAX_ACTIVE_SETUPS = 30;

function storePath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "setups.json");
}

export function listSetups(userId: string, options: { includeFinished?: boolean } = {}): Setup[] {
  const path = storePath(userId);
  if (!existsSync(path)) return [];
  let all: Setup[];
  try {
    all = JSON.parse(readFileSync(path, "utf8")) as Setup[];
  } catch {
    return [];
  }
  return options.includeFinished ? all : all.filter((s) => s.status === "active");
}

function saveSetups(userId: string, setups: Setup[]): void {
  const path = storePath(userId);
  mkdirSync(dirname(path), { recursive: true });
  // Finished ones are kept for a while (the app shows what fired), then dropped.
  const keep = setups.filter((s) => s.status === "active" || Date.now() - (s.hits.at(-1)?.at ?? s.createdAt) < 3 * 24 * 60 * 60_000);
  writeFileSync(path, JSON.stringify(keep.slice(-200), null, 2), "utf8");
}

export function updateSetup(userId: string, id: string, patch: Partial<Setup>): Setup | undefined {
  const all = listSetups(userId, { includeFinished: true });
  const i = all.findIndex((s) => s.id === id);
  if (i < 0) return undefined;
  all[i] = { ...all[i], ...patch };
  saveSetups(userId, all);
  return all[i];
}

const isCondition = (c: unknown): c is SetupCondition =>
  !!c && typeof c === "object" && ((c as SetupCondition).op === "above" || (c as SetupCondition).op === "below") && Number((c as SetupCondition).price) > 0;

const PENDING_TYPES = new Set(["buy_limit", "sell_limit", "buy_stop", "sell_stop"]);

export function createSetup(
  userId: string,
  input: { symbol: string; reason: string; steps: unknown[]; cancelIf?: unknown[]; order: Setup["order"]; expiresInHours?: number },
  now = Date.now(),
): Setup {
  const symbol = String(input.symbol ?? "").trim();
  if (!symbol) throw new Error("A setup needs a symbol.");
  if (!String(input.reason ?? "").trim()) throw new Error("A setup needs a reason -- the plan in words.");
  if (!Array.isArray(input.steps) || input.steps.length === 0 || !input.steps.every(isCondition)) {
    throw new Error('A setup needs at least one step, each {op: "above"|"below", price}.');
  }
  if (input.steps.length > 6) throw new Error("At most 6 steps.");
  const cancelIf = input.cancelIf ?? [];
  if (!Array.isArray(cancelIf) || !cancelIf.every(isCondition)) throw new Error('cancelIf entries are {op: "above"|"below", price}.');
  const type = input.order?.type;
  if (!["buy", "sell", ...PENDING_TYPES].includes(type)) throw new Error("order.type must be buy, sell, buy_limit, sell_limit, buy_stop or sell_stop.");
  if (PENDING_TYPES.has(type) && !(Number(input.order.price) > 0)) throw new Error("A pending order needs order.price.");
  if (listSetups(userId).length >= MAX_ACTIVE_SETUPS) throw new Error(`Already ${MAX_ACTIVE_SETUPS} active setups -- cancel some first.`);
  const hours = Math.min(Math.max(Number(input.expiresInHours) || DEFAULT_SETUP_HOURS, 0.25), MAX_SETUP_HOURS);
  const setup: Setup = {
    id: randomBytes(4).toString("hex"),
    symbol,
    reason: String(input.reason).trim(),
    steps: (input.steps as SetupCondition[]).map((c) => ({ op: c.op, price: Number(c.price), note: c.note })),
    cancelIf: (cancelIf as SetupCondition[]).map((c) => ({ op: c.op, price: Number(c.price), note: c.note })),
    order: { type, lots: input.order.lots, price: input.order.price, sl: input.order.sl, tp: input.order.tp },
    stage: 0,
    status: "active",
    createdAt: now,
    expiresAt: now + hours * 60 * 60_000,
    hits: [],
  };
  saveSetups(userId, [...listSetups(userId, { includeFinished: true }), setup]);
  return setup;
}

export function cancelSetup(userId: string, id: string, why = "Cancelled."): Setup {
  const s = listSetups(userId).find((x) => x.id === id);
  if (!s) throw new Error(`No active setup ${id}.`);
  return updateSetup(userId, id, { status: "cancelled", outcome: why })!;
}

const met = (c: SetupCondition, price: number) => (c.op === "above" ? price >= c.price : price <= c.price);

export type SetupAction =
  | { kind: "none" }
  | { kind: "progress"; stage: number }
  | { kind: "cancel"; why: string }
  | { kind: "expire" }
  | { kind: "place" };

/** What one price tick means for a setup. Several steps can be met by one tick only in order. */
export function advanceSetup(s: Setup, price: number, now = Date.now()): SetupAction {
  if (s.status !== "active") return { kind: "none" };
  if (now >= s.expiresAt) return { kind: "expire" };
  const hit = s.cancelIf.find((c) => met(c, price));
  if (hit) return { kind: "cancel", why: `price went ${hit.op} ${hit.price}${hit.note ? ` (${hit.note})` : ""} first -- the idea is off` };
  let stage = s.stage;
  // One tick can satisfy the current step only; the next must happen on a later tick, so
  // "goes up THEN comes back" really needs two different moves.
  if (stage < s.steps.length && met(s.steps[stage], price)) stage += 1;
  if (stage >= s.steps.length) return { kind: "place" };
  return stage !== s.stage ? { kind: "progress", stage } : { kind: "none" };
}

/** One line for a message: "XAUUSD: above 2660 -> below 2650, then BUY (SL 2641 TP 2672)". */
export function describeSetup(s: Setup): string {
  const steps = s.steps.map((c, i) => `${i < s.stage ? "✓ " : ""}${c.op} ${c.price}`).join(" → ");
  const o = s.order;
  const cancel = s.cancelIf.length ? `; cancel if ${s.cancelIf.map((c) => `${c.op} ${c.price}`).join(" or ")}` : "";
  return `${s.symbol}: ${steps}, then ${o.type.toUpperCase().replace("_", " ")}${o.price ? ` @ ${o.price}` : ""}${o.sl ? ` SL ${o.sl}` : ""}${o.tp ? ` TP ${o.tp}` : ""}${cancel}`;
}
