import type { DaveDatabase } from "@dave/db";
import type { ProviderKeyConfig } from "./provider-catalog.js";
import { PROVIDER_CATALOG } from "./provider-catalog.js";
import { buildProvider } from "./provider-factory.js";
import { fetchAvailableModels } from "./model-fetch.js";
import { ProviderError, type CompletionRequest, type CompletionResult, type ProviderName } from "./providers.js";

/**
 * Update 3: "up to 20 stored keys per provider with health-check
 * auto-failover" -- a layer BELOW the existing cross-provider
 * ProviderRouter (provider-router.ts). That router fails over from one
 * provider to another (e.g. openai -> deepseek -> claude); this fails
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
 * Real security bug fixed (bug-hunt pass on a live bot). Two agent-callable tools handed real,
 * plaintext API keys straight back to the model: `list_provider_keys` returned every
 * StoredProviderKey verbatim, and `add_provider_keys_bulk` echoed each submitted key back as
 * `BulkAddResult.line`. Anything in a tool result enters the model's context -- sent to whatever
 * third-party provider serves that turn -- and can be echoed into a Telegram reply. The admin
 * panel has always redacted these on its own route; the agent path never did.
 *
 * Enough of the tail is kept to tell two stored keys apart (which is the only real reason to look
 * at a key value), and never enough to use one.
 */
export function maskKeyValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length <= 4) return "****";
  return `****${value.slice(-4)}`;
}

export function maskProviderKey(key: StoredProviderKey): StoredProviderKey {
  return { ...key, config: { ...key.config, apiKey: maskKeyValue(key.config.apiKey)!, secretAccessKey: maskKeyValue(key.config.secretAccessKey) } };
}

export function maskProviderKeys(keys: StoredProviderKey[]): StoredProviderKey[] {
  return keys.map(maskProviderKey);
}

/** The submitted key itself is never echoed back -- only whether that line worked, and why not. */
export function maskBulkAddResults(results: BulkAddResult[]): BulkAddResult[] {
  return results.map((result) => ({
    ...result,
    line: maskKeyValue(result.line)!,
    key: result.key ? maskProviderKey(result.key) : undefined,
  }));
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

/**
 * Real bug fixed, reproduced live against the trader's own real NVIDIA key (2026-09-19). The key
 * was genuinely VALID -- GET https://integrate.api.nvidia.com/v1/models returned a real HTTP 200
 * with 82 models on it -- but every chat completion failed, and what the trader saw was "the api
 * is invalid". The real response:
 *
 *   HTTP 410 {"title":"Gone","detail":"The model 'deepseek-ai/deepseek-v4-pro-0813' has reached
 *             its end of life on 2026-09-14T08:00:00Z and is no longer available."}
 *
 * That is a dead MODEL, not a dead key, and the two failures need opposite handling. The failover
 * loop marked the key `healthy: 0` and moved on, so:
 *   1. a perfectly good key was recorded as broken, and reported to the trader as invalid;
 *   2. every remaining key for that provider was then burned on the identical error, because they
 *      all send the same catalog default model -- N pointless round trips per message, which is
 *      also a real and significant chunk of the "why is the bot so slow" complaint;
 *   3. it never self-corrected, because the retry path that exists (isModelScopedRateLimit above)
 *      retries with the CATALOG DEFAULT -- and here the catalog default was the dead model.
 *
 * Matches the real shapes providers actually send for this: NVIDIA's 410 "end of life", OpenAI's
 * "model_not_found", Groq's "does not exist or you do not have access to it", Cerebras/Mistral's
 * 404s, and the "decommissioned"/"no longer available"/"retired" wording several vendors use.
 * Deliberately requires a model-ish signal, so a plain 404 from a wrong base URL or a bare
 * "not found" does NOT match -- that genuinely is a config problem worth surfacing differently.
 */
export function isModelUnavailableError(reason: string): boolean {
  if (/\b(401|403)\b|invalid api key|incorrect api key|authentication/i.test(reason)) return false;

  // NVIDIA NIM's own shape for "this model is in the catalog but your account can't serve it",
  // confirmed live 2026-09-19 against the trader's real key:
  //   HTTP 404 {"title":"Not Found","detail":"Function '23d4f03a-...': Not found for account
  //             'l1iKH_cM8Xh0...'"}
  // Note it never says "model" -- it names the internal function id instead -- so the generic
  // rule below genuinely does not catch it. This matters a lot in practice: most of the 82 ids
  // NVIDIA's /v1/models returns are NOT actually servable on a given account, so without this an
  // ordinary model pick marks a perfectly good key as invalid.
  if (/not found for account/i.test(reason)) return true;

  const modelish = /\bmodel\b|\bmodels\b/i.test(reason);
  const goneish =
    /end of life|no longer available|\bgone\b|decommissioned|deprecated|retired|model_not_found|does not exist|not found|unknown model|invalid model|unsupported model/i.test(
      reason
    );
  return modelish && goneish;
}

/**
 * Thrown instead of AllProviderKeysFailedError when the real cause is the configured model rather
 * than the key, so the caller can say something true and actionable ("that model is gone, here are
 * the real ones") instead of the flatly wrong "your key is invalid" the trader was being shown.
 */
export class ModelUnavailableError extends Error {
  constructor(
    public readonly provider: ProviderName,
    public readonly model: string,
    public readonly reason: string,
    public readonly availableModels: string[] = []
  ) {
    const suggestion =
      availableModels.length > 0
        ? ` Real models currently available on this provider include: ${availableModels.slice(0, 8).join(", ")}.`
        : "";
    super(
      `The model "${model}" is no longer available on ${provider} -- your API key is fine, the model is not. ${reason}${suggestion}`
    );
    this.name = "ModelUnavailableError";
  }
}

/** Model ids that are real but are not chat models -- never auto-switch a chat request onto one. */
const NON_CHAT_MODEL = /embed|rerank|whisper|tts|speech|audio|image|vision|diffusion|guard|moderat|ocr|bge|clip/i;

/**
 * Picks the closest live replacement for a model that has gone away, by longest shared prefix on
 * the id. Real ids carry their family in the string ("deepseek-ai/deepseek-v4-pro-0813" ->
 * "deepseek-ai/deepseek-v4-flash-0731"; "Claude-Sonnet-4.6" -> "claude-sonnet-4.6"), so this
 * reliably lands in the same family rather than jumping to an unrelated vendor's model.
 *
 * Returns undefined rather than guessing when nothing plausibly matches -- an arbitrary model from
 * a stranger's catalog is worse than an honest error, because it would silently change which model
 * is trading.
 */
export function pickReplacementModel(deadModel: string, available: string[]): string | undefined {
  const candidates = available.filter((m) => !NON_CHAT_MODEL.test(m));
  if (candidates.length === 0) return undefined;
  const dead = deadModel.toLowerCase();

  // A pure case difference is the single most common form of this (Poe documents
  // "Claude-Sonnet-4.6" while its real catalog lists "claude-sonnet-4.6").
  const caseMatch = candidates.find((m) => m.toLowerCase() === dead);
  if (caseMatch) return caseMatch;

  const sharedPrefix = (a: string, b: string): number => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  };
  let best: string | undefined;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = sharedPrefix(dead, candidate.toLowerCase());
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  // Require a real family match, not one coincidental letter.
  return bestScore >= 4 ? best : undefined;
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

      // Real bug fixed (see isModelUnavailableError above -- reproduced live on the trader's own
      // NVIDIA key, which was valid while every completion failed with a 410 "end of life").
      // A dead model is not a dead key, so this must never mark the key unhealthy, and must never
      // fall through to the other keys: they all send the same model and would all fail
      // identically, turning one bad config into N wasted round trips per message.
      //
      // Instead it self-heals once, on the SAME key: ask the provider what models it really has
      // right now, pick one, and retry the in-flight request with it. That is the only way this
      // recovers without the trader hand-editing a model id -- the existing model-scoped-rate-limit
      // retry can't help here, because it retries with the catalog default, and the catalog default
      // is exactly what went end-of-life.
      if (isModelUnavailableError(reason)) {
        const deadModel = key.config.model ?? PROVIDER_CATALOG[provider]?.defaultModel ?? "(default)";
        let available: string[] = [];
        try {
          const listed = await fetchAvailableModels(provider, key.config, Math.max(1, Math.min(10_000, deadline - Date.now())));
          available = listed.models;
        } catch {
          // No live list (manual-entry provider, or the models endpoint failed). Nothing to retry
          // with -- fall through to the honest error below rather than guessing a model id.
        }
        const replacement = pickReplacementModel(deadModel, available);
        if (replacement) {
          try {
            const retried = await buildProvider(provider, { ...key.config, model: replacement }).generate(
              req,
              Math.max(1, deadline - Date.now()),
              signal
            );
            // It worked. Persist the live model so the next message doesn't repeat this discovery,
            // and keep the key marked healthy -- it never stopped being healthy.
            db.update(TABLE, userId, key.id, {
              // The model lives inside the serialized config blob, not its own column -- writing
              // it as a bare field silently fails with "no such column: model".
              config_json: JSON.stringify({ ...key.config, model: replacement }),
              healthy: 1,
              last_checked_at: Date.now(),
              last_error: `auto-switched model: "${deadModel}" is gone, now using "${replacement}"`,
              rate_limited_until: null,
            });
            return retried;
          } catch (retryErr) {
            // The replacement didn't work either -- report the original, honest cause below.
            // Logged rather than silently swallowed: when auto-recovery fails, the reason why is
            // the only clue anyone has for why a provider still looks broken.
            console.error(
              `[provider-keys] ${provider}: "${deadModel}" is gone; retry on "${replacement}" also failed:`,
              retryErr instanceof Error ? retryErr.message : retryErr
            );
          }
        }
        // The key is fine; say so plainly rather than recording it as broken.
        db.update(TABLE, userId, key.id, { healthy: 1, last_checked_at: Date.now(), last_error: reason, rate_limited_until: null });
        throw new ModelUnavailableError(provider, deadModel, reason, available);
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
