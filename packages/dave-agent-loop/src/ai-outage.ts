/**
 * When the AI itself is down -- out of credit, a dead key, every provider failing -- a trading scan
 * still pulled the whole multi-timeframe analysis from MT5 (the trader: "it's just sending ea
 * request like 6 or 7 times when the api credit ran out -- it should just tell me"). This remembers
 * the outage and backs off: the next scans are skipped before any MT5 request, the wait doubling
 * from 2 up to 30 minutes, and one real attempt is let through each time the wait runs out.
 */

const FIRST_WAIT_MS = 2 * 60_000;
const MAX_WAIT_MS = 30 * 60_000;

interface Outage {
  since: number;
  failures: number;
  retryAt: number;
  reason: string;
}

const outages = new Map<string, Outage>();

/** A friendly one-liner for what went wrong, credit problems named as such. */
export function describeAiFailure(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/credit|quota|insufficient|billing|balance|payment|402|exceeded your current/i.test(raw)) return `the AI account is out of credit (${raw.slice(0, 160)})`;
  if (/401|403|unauthori[sz]ed|invalid.*key|api key/i.test(raw)) return `the AI key was refused (${raw.slice(0, 160)})`;
  if (/429|rate.?limit|too many requests/i.test(raw)) return `the AI is rate-limiting us (${raw.slice(0, 160)})`;
  return `the AI didn't answer (${raw.slice(0, 160)})`;
}

/** Records a failed model call. Returns the outage, `isNew` when this is the first failure. */
export function markAiOutage(userId: string, err: unknown, now = Date.now()): Outage & { isNew: boolean } {
  const prev = outages.get(userId);
  const failures = (prev?.failures ?? 0) + 1;
  const wait = Math.min(FIRST_WAIT_MS * 2 ** (failures - 1), MAX_WAIT_MS);
  const next: Outage = { since: prev?.since ?? now, failures, retryAt: now + wait, reason: describeAiFailure(err) };
  outages.set(userId, next);
  return { ...next, isNew: !prev };
}

/** The outage still holding scans back, if any. */
export function activeAiOutage(userId: string, now = Date.now()): Outage | undefined {
  const o = outages.get(userId);
  return o && now < o.retryAt ? o : undefined;
}

/** A model call worked. Returns how long it had been down, when it had been. */
export function clearAiOutage(userId: string, now = Date.now()): number | undefined {
  const o = outages.get(userId);
  if (!o) return undefined;
  outages.delete(userId);
  return now - o.since;
}
