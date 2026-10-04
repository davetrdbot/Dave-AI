import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Pairs Dave can't actually trade right now (the trader, from the logs: "a problem with XPTUSD --
 * when there is a problem like that the bot should report or leave the pair, it shouldn't keep
 * requesting"). Two ways a pair lands here:
 *
 *   - the broker doesn't offer it: the EA says so when it fills Market Watch ("not on this broker");
 *   - it keeps coming back with no data on any timeframe (no history loaded, symbol disabled...).
 *
 * The scan skips a benched pair until its time is up, and the trader is told once, not every cycle.
 */

export const NO_DATA_STRIKES = 2;
export const BENCH_HOURS = 6;
export const NOT_ON_BROKER_HOURS = 24;

interface Entry {
  symbol: string;
  reason: string;
  until: number;
  since: number;
}

interface State {
  benched: Entry[];
  strikes: Record<string, number>;
}

function path(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "unavailable-symbols.json");
}

function load(userId: string): State {
  try {
    if (existsSync(path(userId))) return JSON.parse(readFileSync(path(userId), "utf8")) as State;
  } catch {
    /* a broken file just starts fresh */
  }
  return { benched: [], strikes: {} };
}

function save(userId: string, s: State): void {
  mkdirSync(dirname(path(userId)), { recursive: true });
  writeFileSync(path(userId), JSON.stringify(s, null, 2), "utf8");
}

const key = (s: string) => s.trim().toUpperCase();

/** Pairs benched right now (expired ones are dropped). */
export function listUnavailableSymbols(userId: string, now = Date.now()): Entry[] {
  return load(userId).benched.filter((e) => e.until > now);
}

export function isSymbolUnavailable(userId: string, symbol: string, now = Date.now()): Entry | undefined {
  return listUnavailableSymbols(userId, now).find((e) => key(e.symbol) === key(symbol));
}

/** Benches pairs. Returns the ones that were NOT already benched -- the ones worth telling about. */
export function benchSymbols(userId: string, symbols: string[], reason: string, hours: number, now = Date.now()): string[] {
  const s = load(userId);
  s.benched = s.benched.filter((e) => e.until > now);
  const fresh: string[] = [];
  for (const sym of symbols) {
    const existing = s.benched.find((e) => key(e.symbol) === key(sym));
    if (existing) {
      existing.until = Math.max(existing.until, now + hours * 3_600_000);
      existing.reason = reason;
    } else {
      s.benched.push({ symbol: key(sym), reason, until: now + hours * 3_600_000, since: now });
      fresh.push(key(sym));
    }
    delete s.strikes[key(sym)];
  }
  save(userId, s);
  return fresh;
}

/** A scan got no data at all for this pair. Returns the bench entry once it has struck out. */
export function recordNoData(userId: string, symbol: string, detail: string, now = Date.now()): { benched: boolean; strikes: number } {
  const s = load(userId);
  const k = key(symbol);
  s.strikes[k] = (s.strikes[k] ?? 0) + 1;
  const strikes = s.strikes[k];
  save(userId, s);
  if (strikes < NO_DATA_STRIKES) return { benched: false, strikes };
  benchSymbols(userId, [k], `no data from MT5 on any timeframe ${strikes} scans in a row (${detail})`, BENCH_HOURS, now);
  return { benched: true, strikes };
}

/** Data came back: the pair is fine, forget earlier misses. */
export function recordHasData(userId: string, symbol: string): void {
  const s = load(userId);
  if (s.strikes[key(symbol)] === undefined) return;
  delete s.strikes[key(symbol)];
  save(userId, s);
}

/** Lifts a bench early (the trader added the pair in MT5, or asked Dave to try again). */
export function clearUnavailable(userId: string, symbol?: string): void {
  const s = load(userId);
  s.benched = symbol ? s.benched.filter((e) => key(e.symbol) !== key(symbol)) : [];
  if (symbol) delete s.strikes[key(symbol)];
  else s.strikes = {};
  save(userId, s);
}

/** MT5 was not connected to the broker: pairs benched as "isn't on this broker" in that state were
 *  not really missing -- lift those benches (a pair that truly is missing gets benched again). */
export function clearBenchesFromDisconnect(userId: string): string[] {
  const s = load(userId);
  const lifted = s.benched.filter((e) => /isn't on this broker|not in its symbol list/i.test(e.reason)).map((e) => e.symbol);
  if (!lifted.length) return [];
  s.benched = s.benched.filter((e) => !lifted.includes(e.symbol));
  for (const sym of lifted) delete s.strikes[key(sym)];
  save(userId, s);
  return lifted;
}

/** Benches set by "no data from MT5 N scans in a row" (not the broker's own missing-pairs list):
 *  lifted when they would leave nothing to scan -- a pair that truly has no data is benched again. */
export function clearNoDataBenches(userId: string): string[] {
  const s = load(userId);
  const lifted = s.benched.filter((e) => /no data from MT5/i.test(e.reason)).map((e) => e.symbol);
  if (!lifted.length) return [];
  s.benched = s.benched.filter((e) => !lifted.includes(e.symbol));
  for (const sym of lifted) delete s.strikes[key(sym)];
  save(userId, s);
  return lifted;
}

/** "66 of 84 pairs in Market Watch (not on this broker: XRPUSD, XPTUSD, ...)" -> the missing ones. */
export function parseNotOnBroker(message: string): string[] {
  const m = message.match(/not on this broker:\s*([^)]*)\)/i);
  return m ? m[1].split(",").map((x) => x.trim()).filter(Boolean) : [];
}
