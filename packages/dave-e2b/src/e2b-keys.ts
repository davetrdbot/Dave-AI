import type { DaveDatabase } from "@dave/db";
import { E2BClient, E2BRequestError, type E2BSandbox, type E2BSandboxConfig } from "./e2b-client.js";

/**
 * Update 12: "Up to 10 stored API keys, health-check failover, same
 * pattern as other provider keys" -- deliberately mirrors
 * dave-brain/provider-keys.ts's own shape exactly (same cap, same
 * healthy/lastCheckedAt/lastError fields, same ordered-failover
 * behavior) rather than inventing a second convention.
 */
const TABLE = "e2b_keys";
const MAX_KEYS = 10;

export interface StoredE2BKey {
  id: string;
  label: string;
  apiKey: string;
  healthy: boolean;
  lastCheckedAt: number | null;
  lastError: string | null;
}

function ensureTable(db: DaveDatabase): void {
  db.createTable(TABLE, [
    { name: "label", type: "TEXT" },
    { name: "api_key", type: "TEXT" },
    { name: "healthy", type: "INTEGER" },
    { name: "last_checked_at", type: "INTEGER" },
    { name: "last_error", type: "TEXT" },
  ]);
}

function toStoredKey(row: Record<string, unknown>): StoredE2BKey {
  return {
    id: row.id as string,
    label: row.label as string,
    apiKey: row.api_key as string,
    healthy: Boolean(row.healthy),
    lastCheckedAt: (row.last_checked_at as number | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
  };
}

export function addE2BKey(db: DaveDatabase, userId: string, label: string, apiKey: string): StoredE2BKey {
  ensureTable(db);
  if (db.query(TABLE, userId, {}).length >= MAX_KEYS) {
    throw new Error(`already at the ${MAX_KEYS}-key limit for E2B`);
  }
  const id = db.insert(TABLE, userId, { label, api_key: apiKey, healthy: 1, last_checked_at: null, last_error: null });
  return toStoredKey(db.getById(TABLE, userId, id)!);
}

export function listE2BKeys(db: DaveDatabase, userId: string): StoredE2BKey[] {
  ensureTable(db);
  return db.query(TABLE, userId, {}).map(toStoredKey);
}

export function removeE2BKey(db: DaveDatabase, userId: string, keyId: string): boolean {
  return db.deleteRow(TABLE, userId, keyId);
}

/** Real health check: a genuine GET /sandboxes call against the real E2B API. */
export async function checkE2BKeyHealth(db: DaveDatabase, userId: string, key: StoredE2BKey, timeoutMs = 8000): Promise<boolean> {
  const client = new E2BClient(key.apiKey);
  try {
    await client.listSandboxes();
    db.update(TABLE, userId, key.id, { healthy: 1, last_checked_at: Date.now(), last_error: null });
    return true;
  } catch (err) {
    const reason = err instanceof E2BRequestError ? err.message : String(err);
    db.update(TABLE, userId, key.id, { healthy: 0, last_checked_at: Date.now(), last_error: reason });
    return false;
  }
}

export class AllE2BKeysFailedError extends Error {
  constructor(public readonly attempts: { keyId: string; label: string; reason: string }[]) {
    super(`All stored E2B keys failed: ${attempts.map((a) => `${a.label} (${a.reason})`).join("; ")}`);
    this.name = "AllE2BKeysFailedError";
  }
}

/** Real auto-failover across stored E2B keys, healthy ones tried first. */
export async function createSandboxWithKeyFailover(db: DaveDatabase, userId: string, config: E2BSandboxConfig = {}): Promise<E2BSandbox> {
  const keys = listE2BKeys(db, userId);
  if (keys.length === 0) throw new Error("no stored E2B keys for this user");
  const ordered = [...keys.filter((k) => k.healthy), ...keys.filter((k) => !k.healthy)];

  const attempts: { keyId: string; label: string; reason: string }[] = [];
  for (const key of ordered) {
    const client = new E2BClient(key.apiKey);
    try {
      const sandbox = await client.createSandbox(config);
      db.update(TABLE, userId, key.id, { healthy: 1, last_checked_at: Date.now(), last_error: null });
      return sandbox;
    } catch (err) {
      const reason = err instanceof E2BRequestError ? err.message : String(err);
      db.update(TABLE, userId, key.id, { healthy: 0, last_checked_at: Date.now(), last_error: reason });
      attempts.push({ keyId: key.id, label: key.label, reason });
    }
  }
  throw new AllE2BKeysFailedError(attempts);
}
