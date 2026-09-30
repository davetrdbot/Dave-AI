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
  /** The AI setup that failed (main AI, backups, their keys and models). */
  setup?: string;
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
export function markAiOutage(userId: string, err: unknown, now = Date.now(), setup?: string): Outage & { isNew: boolean } {
  let prev = outages.get(userId);
  if (prev && setup !== undefined && prev.setup !== setup) prev = undefined; // a different AI failed: start the back-off over
  const failures = (prev?.failures ?? 0) + 1;
  const wait = Math.min(FIRST_WAIT_MS * 2 ** (failures - 1), MAX_WAIT_MS);
  const next: Outage = { since: prev?.since ?? now, failures, retryAt: now + wait, reason: describeAiFailure(err), setup };
  outages.set(userId, next);
  return { ...next, isNew: !prev };
}

/**
 * The outage still holding scans back, if any. With `setup` (the AI setup now): when the trader has
 * since changed it -- a new main AI, a backup, a key or a model -- the old pause is dropped at once.
 * (The trader, live: switched from a dead Claude key to Ollama in the app; chat used Ollama straight
 * away but scans kept waiting out Claude's back-off and repeating Claude's error for 16 minutes.)
 */
export function activeAiOutage(userId: string, now = Date.now(), setup?: string): Outage | undefined {
  const o = outages.get(userId);
  if (o && setup !== undefined && o.setup !== undefined && o.setup !== setup) {
    outages.delete(userId);
    console.log(`[ai-outage] ${userId}: AI changed -- scanning again`);
    return undefined;
  }
  return o && now < o.retryAt ? o : undefined;
}

/** A model call worked. Returns how long it had been down, when it had been. */
export function clearAiOutage(userId: string, now = Date.now()): number | undefined {
  const o = outages.get(userId);
  if (!o) return undefined;
  outages.delete(userId);
  return now - o.since;
}

/** A short fingerprint of the AI setup: main, backups, and each one's keys and models. */
export function aiSetupFingerprint(config: { primary: string; fallback: string[] }, keysOf: (provider: string) => { id: string; model?: string }[]): string {
  const order = [config.primary, ...config.fallback.filter((p) => p !== config.primary)];
  return order.map((p) => `${p}:${keysOf(p).map((k) => `${k.id}/${k.model ?? ""}`).join(",")}`).join("|");
}
