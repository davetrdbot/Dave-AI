import type { DaveDatabase } from "@dave/db";
import type { ProviderKeyConfig } from "./provider-catalog.js";
import { buildProvider } from "./provider-factory.js";
import { ProviderError, type CompletionRequest, type CompletionResult, type ProviderName } from "./providers.js";

/**
 * Update 3: "up to 10 stored keys per provider with health-check
 * auto-failover" -- a layer BELOW the existing cross-provider
 * ProviderRouter (provider-router.ts). That router fails over from one
 * provider to another (e.g. airllm -> deepseek -> claude); this fails
 * over between multiple keys held for the SAME provider (e.g. three
 * OpenAI keys, one rate-limited).
 */
const TABLE = "provider_keys";
const MAX_KEYS_PER_PROVIDER = 10;

export interface StoredProviderKey {
  id: string;
  provider: ProviderName;
  label: string;
  config: ProviderKeyConfig;
  healthy: boolean;
  lastCheckedAt: number | null;
  lastError: string | null;
}

function ensureTable(db: DaveDatabase): void {
  db.createTable(TABLE, [
    { name: "provider", type: "TEXT" },
    { name: "label", type: "TEXT" },
    { name: "config_json", type: "TEXT" },
    { name: "healthy", type: "INTEGER" },
    { name: "last_checked_at", type: "INTEGER" },
    { name: "last_error", type: "TEXT" },
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
  });
  return toStoredKey(db.getById(TABLE, userId, id)!);
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
 */
export async function generateWithKeyFailover(
  db: DaveDatabase,
  userId: string,
  provider: ProviderName,
  req: CompletionRequest,
  timeoutMs = 15000
): Promise<CompletionResult> {
  const keys = listProviderKeys(db, userId, provider);
  if (keys.length === 0) {
    throw new Error(`no stored keys for provider "${provider}"`);
  }
  const ordered = [...keys.filter((k) => k.healthy), ...keys.filter((k) => !k.healthy)];

  const attempts: { keyId: string; label: string; reason: string }[] = [];
  for (const key of ordered) {
    const instance = buildProvider(provider, key.config);
    try {
      const result = await instance.generate(req, timeoutMs);
      db.update(TABLE, userId, key.id, { healthy: 1, last_checked_at: Date.now(), last_error: null });
      return result;
    } catch (err) {
      const reason = err instanceof ProviderError ? err.message : String(err);
      db.update(TABLE, userId, key.id, { healthy: 0, last_checked_at: Date.now(), last_error: reason });
      attempts.push({ keyId: key.id, label: key.label, reason });
    }
  }
  throw new AllProviderKeysFailedError(provider, attempts);
}
