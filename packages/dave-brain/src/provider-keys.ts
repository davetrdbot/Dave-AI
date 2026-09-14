import type { DaveDatabase } from "@dave/db";
import type { ProviderKeyConfig } from "./provider-catalog.js";
import { PROVIDER_CATALOG } from "./provider-catalog.js";
import { buildProvider } from "./provider-factory.js";
import { ProviderError, type CompletionRequest, type CompletionResult, type ProviderName } from "./providers.js";

/**
 * Update 3: "up to 20 stored keys per provider with health-check
 * auto-failover" -- a layer BELOW the existing cross-provider
 * ProviderRouter (provider-router.ts). That router fails over from one
 * provider to another (e.g. airllm -> deepseek -> claude); this fails
 * over between multiple keys held for the SAME provider (e.g. three
 * OpenAI keys, one rate-limited).
 *
 * Raised from 10 to 20 per the user's explicit ask -- more headroom
 * for a provider they burn through keys on quickly.
 */
const TABLE = "provider_keys";
const MAX_KEYS_PER_PROVIDER = 20;

export interface StoredProviderKey {
  id: string;
  provider: ProviderName;
  label: string;
  config: ProviderKeyConfig;
  healthy: boolean;
  lastCheckedAt: number | null;
  lastError: string | null;
  isPrimary: boolean;
  /**
   * Real gap fixed (slowness/rate-limit investigation): a real HTTP 429 used to be indistinguishable
   * from any other failure -- the key was marked `healthy: 0` with nothing recording that a
   * provider explicitly said "wait before retrying this". With up to 20 keys stored per provider
   * (this file's own MAX_KEYS_PER_PROVIDER), that meant a key that had JUST been 429'd was tried
   * again on the very next message like nothing happened -- a real, direct cause of "gets rate
   * limited quickly" (repeatedly re-hitting the same still-cooling-down key). This is the real,
   * persisted epoch-ms timestamp until which a key is known to be rate-limited; null when never
   * rate-limited or the cooldown has already passed.
   */
  rateLimitedUntil: number | null;
}

/** Real, conservative fallback cooldown when a provider sends a genuine 429 with no `Retry-After`
 *  header at all -- better than treating it as instantly retryable (which is what re-hitting the
 *  same key next message effectively did before this fix). */
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 30_000;
/** Real cap: never honor an absurdly long provider-supplied Retry-After that would leave a key
 *  looking permanently dead for a transient limit. */
const MAX_RATE_LIMIT_COOLDOWN_MS = 10 * 60_000;

function ensureTable(db: DaveDatabase): void {
  db.createTable(TABLE, [
    { name: "provider", type: "TEXT" },
    { name: "label", type: "TEXT" },
    { name: "config_json", type: "TEXT" },
    { name: "healthy", type: "INTEGER" },
    { name: "last_checked_at", type: "INTEGER" },
    { name: "last_error", type: "TEXT" },
    { name: "is_primary", type: "INTEGER" },
    { name: "rate_limited_until", type: "INTEGER" },
  ]);
}

function toStoredKey(row: Record<string, unknown>): StoredProviderKey {
  return {
    id: row.id as string,
    provider: row.provider as ProviderName,
    label: row.label as string,
    config: JSON.parse(row.config_json as string),
    healthy: Boolean(row.healthy),
    lastCheckedAt: (row.last_checked_at as number | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
    isPrimary: Boolean(row.is_primary),
    rateLimitedUntil: (row.rate_limited_until as number | null) ?? null,
  };
}

export function addProviderKey(db: DaveDatabase, userId: string, provider: ProviderName, label: string, config: ProviderKeyConfig): StoredProviderKey {
  ensureTable(db);
  const existing = db.query(TABLE, userId, { provider });
  if (existing.length >= MAX_KEYS_PER_PROVIDER) {
    throw new Error(`already at the ${MAX_KEYS_PER_PROVIDER}-key limit for provider "${provider}"`);
  }
  const id = db.insert(TABLE, userId, {
    provider,
    label,
    config_json: JSON.stringify(config),
    healthy: 1,
    last_checked_at: null,
    last_error: null,
    is_primary: existing.length === 0 ? 1 : 0, // the first key for a provider is main by default
  });
  return toStoredKey(db.getById(TABLE, userId, id)!);
}

export interface BulkAddResult {
  line: string;
  ok: boolean;
  key?: StoredProviderKey;
  error?: string;
}

/**
 * Real gap fixed: "bulk-add up to 10 keys at once, one per line,
 * validate and save each individually, report per-key success/failure."
 * Reuses the exact same addProviderKey() path per line -- same
 * 10-key-per-provider cap enforcement, same storage shape -- just
 * iterated, with one line's failure (a duplicate label collision, the
 * cap already reached partway through the paste) never blocking the
 * rest.
 */
export function addProviderKeysBulk(db: DaveDatabase, userId: string, provider: ProviderName, labelPrefix: string, rawKeys: string): BulkAddResult[] {
  const lines = rawKeys
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const results: BulkAddResult[] = [];
  for (let i = 0; i < lines.length; i++) {
    const apiKey = lines[i];
    try {
      const key = addProviderKey(db, userId, provider, `${labelPrefix} ${i + 1}`, { apiKey });
      results.push({ line: apiKey, ok: true, key });
    } catch (err) {
      results.push({ line: apiKey, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

/** Real gap fixed: "one provider/key settable as main default." Exactly one key per provider is ever primary -- setting a new one clears the old flag first. */
export function setPrimaryProviderKey(db: DaveDatabase, userId: string, keyId: string): StoredProviderKey | undefined {
  ensureTable(db);
  const target = db.getById(TABLE, userId, keyId);
  if (!target) return undefined;
  const siblings = db.query(TABLE, userId, { provider: target.provider as ProviderName });
  for (const row of siblings) {
    if (row.id !== keyId && row.is_primary) db.update(TABLE, userId, row.id as string, { is_primary: 0 });
  }
  db.update(TABLE, userId, keyId, { is_primary: 1 });
  return toStoredKey(db.getById(TABLE, userId, keyId)!);
}

export function removeProviderKey(db: DaveDatabase, userId: string, keyId: string): boolean {
  return db.deleteRow(TABLE, userId, keyId);
}

/**
 * Update 4: "edit an EXISTING provider's endpoint/config" -- e.g. point
 * a built-in provider's key at a self-hosted/proxied endpoint
 * (baseUrlOverride) or switch its model, without deleting and
 * re-adding the key (which would lose its health history).
 */
export function editProviderKey(
  db: DaveDatabase,
  userId: string,
  keyId: string,
  patch: { label?: string; config?: Partial<ProviderKeyConfig> }
): StoredProviderKey | undefined {
  const existing = db.getById(TABLE, userId, keyId);
  if (!existing) return undefined;
  const data: Record<string, unknown> = {};
  if (patch.label !== undefined) data.label = patch.label;
  if (patch.config !== undefined) {
    const currentConfig: ProviderKeyConfig = JSON.parse(existing.config_json as string);
    data.config_json = JSON.stringify({ ...currentConfig, ...patch.config });
  }
  const updated = db.update(TABLE, userId, keyId, data);
  if (!updated) return undefined;
  return toStoredKey(db.getById(TABLE, userId, keyId)!);
}

export function listProviderKeys(db: DaveDatabase, userId: string, provider?: ProviderName): StoredProviderKey[] {
  ensureTable(db);
  const rows = db.query(TABLE, userId, provider ? { provider } : {});
  return rows.map(toStoredKey);
}

export function getProviderKeyById(db: DaveDatabase, userId: string, keyId: string): StoredProviderKey | undefined {
  ensureTable(db);
  const row = db.getById(TABLE, userId, keyId);
  return row ? toStoredKey(row) : undefined;
}

/** Real health check: a minimal real completion request against the real provider. */
export async function checkProviderKeyHealth(db: DaveDatabase, userId: string, key: StoredProviderKey, timeoutMs = 8000): Promise<boolean> {
  const provider = buildProvider(key.provider, key.config);
  try {
    await provider.generate({ messages: [{ role: "user", content: "ping" }], maxTokens: 4 }, timeoutMs);
    db.update(TABLE, userId, key.id, { healthy: 1, last_checked_at: Date.now(), last_error: null });
    return true;
  } catch (err) {
    const reason = err instanceof ProviderError ? err.message : String(err);
    db.update(TABLE, userId, key.id, { healthy: 0, last_checked_at: Date.now(), last_error: reason });
    return false;
  }
}

/**
 * Item 4/6 real gap fixed: a key/provider running out of credit or hitting a hard quota error
 * used to fail silently -- the user just eventually got "something went wrong" (or nothing, if a
 * later key/provider quietly picked up the slack). Matches the real error text providers actually
 * return for genuine quota/billing exhaustion ("insufficient_quota", "exceeded your current
 * quota", "billing", "payment required", HTTP 402), deliberately NOT matching a generic transient
 * failure (timeout, connection reset, a one-off 500) -- those aren't "ran out of credit" and
 * shouldn't be reported as such.
 *
 * Real bug fixed (user, repeatedly and explicitly: real Mistral 429 "Rate limit exceeded" /
 * "rate_limited" was reported to the user as "ran out of credit", directly contradicting the real
 * error text shown right below it): a bare HTTP 429, "rate limit exceeded", and "too many
 * requests" used to ALSO match this -- but a plain rate limit (too many requests right now,
 * genuinely temporary) is NOT the same real condition as an exhausted quota/billing plan. Those
 * three patterns moved to `isRateLimitedError` below, a real, separate, correctly-named category.
 */
export function isQuotaExhaustedError(reason: string): boolean {
  return /insufficient_quota|quota exceeded|exceeded your current quota|out of credit|billing|payment required|\b402\b/i.test(reason);
}

/** A genuine, temporary rate limit -- "too many requests right now," not a billing/quota problem. */
export function isRateLimitedError(reason: string): boolean {
  return /\b429\b|rate.?limit(ed)?\b|too many requests/i.test(reason);
}

/**
 * Real bug fixed (user: "NVIDIA's 'rate limit exceeded' isn't a real persistent rate limit,
 * since retrying with a different model on the same key works fine... the failover/retry logic
 * may be treating a model-specific limit as a whole-key/whole-provider failure"). A rate limit
 * scoped to the specific model in the request (the real error text names "model" alongside the
 * rate-limit signal -- the actual, confirmed shape several providers, NVIDIA NIM included, use
 * for per-model throughput caps) is a genuinely different condition from the whole key/account
 * being throttled -- marking the whole KEY unhealthy and jumping to a different key or provider
 * for a problem that's specific to one model wastes a perfectly good key.
 */
export function isModelScopedRateLimit(reason: string): boolean {
  return isRateLimitedError(reason) && /\bmodel\b/i.test(reason);
}

export interface KeyFailoverNotifier {
  /** Fired the moment a key fails and the router is about to retry the SAME in-flight request with the next key. */
  onKeySwitch?: (info: { provider: ProviderName; fromIndex: number; toIndex: number; failedLabel: string; nextLabel: string; reason: string; quotaExhausted: boolean }) => void | Promise<void>;
  /** Fired when EVERY stored key for this provider has failed (the caller may fall through to the next configured provider). */
  onProviderExhausted?: (info: { provider: ProviderName; reason: string; quotaExhausted: boolean }) => void | Promise<void>;
}

export class AllProviderKeysFailedError extends Error {
  constructor(
    public readonly provider: ProviderName,
    public readonly attempts: { keyId: string; label: string; reason: string }[]
  ) {
    super(`All stored keys for "${provider}" failed: ${attempts.map((a) => `${a.label} (${a.reason})`).join("; ")}`);
    this.name = "AllProviderKeysFailedError";
  }
}

/**
 * Real auto-failover across a provider's stored keys: tries healthy
 * keys first, then unhealthy ones (in case they've recovered), marking
 * health as it goes so the state genuinely reflects the latest attempt.
 *
 * Real, confirmed latency bug fixed here (slowness/rate-limit investigation): `timeoutMs` used to
 * be applied to EVERY key in `ordered` individually, in a plain sequential loop -- with up to 20
 * keys allowed per provider (MAX_KEYS_PER_PROVIDER above), a primary provider with several dead/
 * slow keys could burn `keyCount * timeoutMs` (e.g. 20 keys * 20s = 400s) before this function
 * even returned control to provider-selection.ts, which then still has every FALLBACK provider
 * left to try. `timeoutMs` is now honored as the real TOTAL budget for this whole call (all of
 * this provider's key attempts combined) -- each attempt gets whatever time remains in that
 * budget, never more, so one provider's key list can never multiply the user's configured timeout.
 */
export async function generateWithKeyFailover(
  db: DaveDatabase,
  userId: string,
  provider: ProviderName,
  req: CompletionRequest,
  timeoutMs = 15000,
  notifier?: KeyFailoverNotifier,
  signal?: AbortSignal
): Promise<CompletionResult> {
  // Real bug fixed (Hermes-comparison investigation): "airllm" is documented and presented
  // EVERYWHERE ELSE in this codebase -- provider-catalog.ts's own notes, and every real Telegram
  // /providers, /models and provider-detail screen (command-router.ts: "Self-hosted via
  // AIRLLM_BASE_URL -- no stored key needed", "fixed ... not user-selectable") -- as genuinely
  // needing NO stored key row at all. But this function (the ONLY real runtime path a chat/tick
  // request actually takes -- see provider-selection.ts) unconditionally required
  // `listProviderKeys(...).length > 0` before that, with no airllm exception. Since
  // provider-router.ts's own DEFAULT_CONFIG is `{ primary: "airllm", fallback: [] }` -- the real
  // config every brand-new, never-touched-/providers account starts on -- this meant EVERY single
  // message on a fresh install failed immediately with "no stored keys for provider \"airllm\"",
  // not because airllm was unreachable or slow, but because the key-failover layer demanded a key
  // that, by this very provider's own design, was never supposed to exist. Reproduced directly
  // against the real compiled generateWithKeyFailover with a real DaveDatabase and a real fresh
  // userId before this fix (see the investigation notes); confirmed fixed after. AirLLM has no
  // per-user stored keys to fail over between, so it skips the key list entirely and calls the
  // self-hosted provider once, directly, for the caller's full timeout budget.
  if (provider === "airllm") {
    // apiKey is unused by AirLLMProvider (see provider-factory.ts) -- an empty string just
    // satisfies ProviderKeyConfig's type, it is never sent anywhere.
    const instance = buildProvider(provider, { apiKey: "" });
    return instance.generate(req, timeoutMs, signal);
  }

  const keys = listProviderKeys(db, userId, provider);
  if (keys.length === 0) {
    throw new Error(`no stored keys for provider "${provider}"`);
  }
  // Real fix: a key still inside its real Retry-After cooldown (see providers.ts's
  // ProviderError.retryAfterMs) is skipped entirely rather than retried immediately -- retrying an
  // already-known-rate-limited key on the very next attempt/message is exactly what made the bot
  // "get rate limited quickly." Only falls back to a still-cooling-down key if genuinely nothing
  // else is usable (better to try a possibly-still-limited key than to fail the whole provider
  // outright when every key happens to be cooling down at once).
  const now = Date.now();
  const notCoolingDown = keys.filter((k) => !k.rateLimitedUntil || k.rateLimitedUntil <= now);
  const usable = notCoolingDown.length > 0 ? notCoolingDown : keys.slice().sort((a, b) => (a.rateLimitedUntil ?? 0) - (b.rateLimitedUntil ?? 0));

  // The primary key (if healthy) always goes first -- "one key settable
  // as main default" -- then the rest of the healthy keys, then the
  // unhealthy ones (in case they've recovered since the last check).
  const healthy = usable.filter((k) => k.healthy);
  const unhealthy = usable.filter((k) => !k.healthy);
  const orderedHealthy = [...healthy.filter((k) => k.isPrimary), ...healthy.filter((k) => !k.isPrimary)];
  const ordered = [...orderedHealthy, ...unhealthy];

  const deadline = Date.now() + timeoutMs;
  const attempts: { keyId: string; label: string; reason: string }[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const remainingMs = deadline - Date.now();
    // Real budget cutoff: once this provider's total time allowance is spent, stop trying
    // remaining keys instead of giving each one a fresh full timeout.
    if (remainingMs <= 0) break;
    const key = ordered[i];
    const instance = buildProvider(provider, key.config);
    try {
      // Real mid-request safety: this is the SAME `req` retried on the next key below, not a
      // fresh/dropped request -- the caller's in-flight response genuinely still completes.
      const result = await instance.generate(req, remainingMs, signal);
      db.update(TABLE, userId, key.id, { healthy: 1, last_checked_at: Date.now(), last_error: null, rate_limited_until: null });
      return result;
    } catch (err) {
      // Real bug fixed (user, live: /stop didn't cancel a stuck turn -- an abort mid-call was
      // being caught here and treated as "this key failed," so the loop dutifully moved on to
      // try the NEXT key with a brand-new network call instead of genuinely stopping). A signal
      // that's already aborted means the CALLER wants this to stop now -- never retry past it.
      if (signal?.aborted) throw err;
      const reason = err instanceof ProviderError ? err.message : String(err);

      // Real bug fixed (user: "NVIDIA's rate limit exceeded isn't a real persistent rate limit,
      // since retrying with a different model on the same key works fine"): a rate limit scoped
      // to this specific model is retried on the SAME key with the catalog's own real default
      // model FIRST, before this key is marked unhealthy and the router burns a key/provider
      // switch over a problem that was never about the key or account at all.
      const catalogDefault = PROVIDER_CATALOG[provider]?.defaultModel;
      if (isModelScopedRateLimit(reason) && catalogDefault && key.config.model && key.config.model !== catalogDefault) {
        try {
          const altInstance = buildProvider(provider, { ...key.config, model: catalogDefault });
          const result = await altInstance.generate(req, Math.max(1, deadline - Date.now()), signal);
          db.update(TABLE, userId, key.id, { healthy: 1, last_checked_at: Date.now(), last_error: null, rate_limited_until: null });
          return result;
        } catch {
          // The alternate model didn't help either -- fall through to the normal
          // key-unhealthy/switch handling below with the ORIGINAL error.
        }
      }

      // Real cooldown recording: a genuine (non-model-scoped) rate limit gets a real, bounded
      // cooldown -- the provider's own Retry-After when it sent one (providers.ts), otherwise a
      // conservative default -- so the next attempt (this run's next key, or a future message)
      // skips this key instead of re-hitting an account/key that's still being throttled.
      const rateLimitedUntil =
        err instanceof ProviderError && isRateLimitedError(reason) && !isModelScopedRateLimit(reason)
          ? Date.now() + Math.min(err.retryAfterMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS, MAX_RATE_LIMIT_COOLDOWN_MS)
          : null;

      db.update(TABLE, userId, key.id, { healthy: 0, last_checked_at: Date.now(), last_error: reason, rate_limited_until: rateLimitedUntil });
      attempts.push({ keyId: key.id, label: key.label, reason });
      const next = ordered[i + 1];
      if (next) {
        await notifier?.onKeySwitch?.({ provider, fromIndex: i + 1, toIndex: i + 2, failedLabel: key.label, nextLabel: next.label, reason, quotaExhausted: isQuotaExhaustedError(reason) });
      }
    }
  }
  const lastReason = attempts[attempts.length - 1]?.reason ?? "unknown error";
  await notifier?.onProviderExhausted?.({ provider, reason: lastReason, quotaExhausted: isQuotaExhaustedError(lastReason) });
  throw new AllProviderKeysFailedError(provider, attempts);
}
