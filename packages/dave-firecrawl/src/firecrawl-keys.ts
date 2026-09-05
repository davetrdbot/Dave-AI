import type { DaveDatabase } from "@dave/db";
import { FirecrawlClient, FirecrawlRequestError, type FirecrawlSearchResult, type FirecrawlScrapeResult } from "./firecrawl-client.js";

/**
 * Part 3 (B1): "stored the same secure way as other provider keys" --
 * deliberately mirrors dave-e2b/e2b-keys.ts's shape exactly (same cap,
 * same healthy/lastCheckedAt/lastError fields, same ordered-failover).
 */
const TABLE = "firecrawl_keys";
const MAX_KEYS = 10;

export interface StoredFirecrawlKey {
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

function toStoredKey(row: Record<string, unknown>): StoredFirecrawlKey {
  return {
    id: row.id as string,
    label: row.label as string,
    apiKey: row.api_key as string,
    healthy: Boolean(row.healthy),
    lastCheckedAt: (row.last_checked_at as number | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
  };
}

export function addFirecrawlKey(db: DaveDatabase, userId: string, label: string, apiKey: string): StoredFirecrawlKey {
  ensureTable(db);
  if (db.query(TABLE, userId, {}).length >= MAX_KEYS) {
    throw new Error(`already at the ${MAX_KEYS}-key limit for Firecrawl`);
  }
  const id = db.insert(TABLE, userId, { label, api_key: apiKey, healthy: 1, last_checked_at: null, last_error: null });
  return toStoredKey(db.getById(TABLE, userId, id)!);
}

export function listFirecrawlKeys(db: DaveDatabase, userId: string): StoredFirecrawlKey[] {
  ensureTable(db);
  return db.query(TABLE, userId, {}).map(toStoredKey);
}

export function removeFirecrawlKey(db: DaveDatabase, userId: string, keyId: string): boolean {
  return db.deleteRow(TABLE, userId, keyId);
}

export class AllFirecrawlKeysFailedError extends Error {
  constructor(public readonly attempts: { keyId: string; label: string; reason: string }[]) {
    super(`All stored Firecrawl keys failed: ${attempts.map((a) => `${a.label} (${a.reason})`).join("; ")}`);
    this.name = "AllFirecrawlKeysFailedError";
  }
}

async function withKeyFailover<T>(db: DaveDatabase, userId: string, call: (client: FirecrawlClient) => Promise<T>): Promise<T> {
  const keys = listFirecrawlKeys(db, userId);
  if (keys.length === 0) throw new Error("no stored Firecrawl keys for this user");
  const ordered = [...keys.filter((k) => k.healthy), ...keys.filter((k) => !k.healthy)];

  const attempts: { keyId: string; label: string; reason: string }[] = [];
  for (const key of ordered) {
    const client = new FirecrawlClient(key.apiKey);
    try {
      const result = await call(client);
      db.update(TABLE, userId, key.id, { healthy: 1, last_checked_at: Date.now(), last_error: null });
      return result;
    } catch (err) {
      const reason = err instanceof FirecrawlRequestError ? err.message : String(err);
      db.update(TABLE, userId, key.id, { healthy: 0, last_checked_at: Date.now(), last_error: reason });
      attempts.push({ keyId: key.id, label: key.label, reason });
    }
  }
  throw new AllFirecrawlKeysFailedError(attempts);
}

export function searchWithKeyFailover(db: DaveDatabase, userId: string, query: string, limit?: number): Promise<FirecrawlSearchResult[]> {
  return withKeyFailover(db, userId, (client) => client.search(query, limit));
}

export function scrapeWithKeyFailover(db: DaveDatabase, userId: string, url: string): Promise<FirecrawlScrapeResult> {
  return withKeyFailover(db, userId, (client) => client.scrape(url));
}
