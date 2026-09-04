import type { DaveDatabase } from "@dave/db";
import { OpenAICompatibleProvider, type CompletionRequest, type CompletionResult } from "./providers.js";

/**
 * Update 4: "create a brand new custom provider (endpoint+key), edit an
 * EXISTING provider's endpoint/config" -- a custom provider is one the
 * static catalog (provider-catalog.ts) has never heard of: the user
 * supplies their own name/base URL/model, assumed OpenAI-compatible
 * (the shape the vast majority of real providers turned out to share,
 * per Update 3's research). Deliberately its OWN table, not shoehorned
 * into provider_keys' fixed ProviderName union.
 */
const TABLE = "custom_providers";

export interface CustomProviderInput {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  chatPath?: string;
}

export interface CustomProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  chatPath: string;
}

function ensureTable(db: DaveDatabase): void {
  db.createTable(TABLE, [
    { name: "name", type: "TEXT" },
    { name: "base_url", type: "TEXT" },
    { name: "api_key", type: "TEXT" },
    { name: "model", type: "TEXT" },
    { name: "chat_path", type: "TEXT" },
  ]);
}

function toCustomProvider(row: Record<string, unknown>): CustomProvider {
  return {
    id: row.id as string,
    name: row.name as string,
    baseUrl: row.base_url as string,
    apiKey: row.api_key as string,
    model: row.model as string,
    chatPath: row.chat_path as string,
  };
}

export function createCustomProvider(db: DaveDatabase, userId: string, input: CustomProviderInput): CustomProvider {
  ensureTable(db);
  const id = db.insert(TABLE, userId, {
    name: input.name,
    base_url: input.baseUrl,
    api_key: input.apiKey,
    model: input.model,
    chat_path: input.chatPath ?? "/chat/completions",
  });
  return toCustomProvider(db.getById(TABLE, userId, id)!);
}

/** Real edit -- endpoint/config of an EXISTING custom provider, not just create. */
export function editCustomProvider(db: DaveDatabase, userId: string, id: string, patch: Partial<CustomProviderInput>): CustomProvider | undefined {
  ensureTable(db);
  const data: Record<string, unknown> = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.baseUrl !== undefined) data.base_url = patch.baseUrl;
  if (patch.apiKey !== undefined) data.api_key = patch.apiKey;
  if (patch.model !== undefined) data.model = patch.model;
  if (patch.chatPath !== undefined) data.chat_path = patch.chatPath;
  const updated = db.update(TABLE, userId, id, data);
  if (!updated) return undefined;
  return toCustomProvider(db.getById(TABLE, userId, id)!);
}

export function listCustomProviders(db: DaveDatabase, userId: string): CustomProvider[] {
  ensureTable(db);
  return db.query(TABLE, userId, {}).map(toCustomProvider);
}

export function getCustomProvider(db: DaveDatabase, userId: string, id: string): CustomProvider | undefined {
  ensureTable(db);
  const row = db.getById(TABLE, userId, id);
  return row ? toCustomProvider(row) : undefined;
}

export function deleteCustomProvider(db: DaveDatabase, userId: string, id: string): boolean {
  ensureTable(db);
  return db.deleteRow(TABLE, userId, id);
}

export async function generateWithCustomProvider(db: DaveDatabase, userId: string, id: string, req: CompletionRequest, timeoutMs = 15000): Promise<CompletionResult> {
  const provider = getCustomProvider(db, userId, id);
  if (!provider) throw new Error(`no custom provider with id "${id}"`);
  const instance = new OpenAICompatibleProvider("custom", provider.baseUrl, provider.apiKey, provider.model, provider.chatPath);
  return instance.generate(req, timeoutMs);
}
