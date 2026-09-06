import type { DaveDatabase } from "@dave/db";
import { addProviderKey, addProviderKeysBulk, editProviderKey, listProviderKeys, removeProviderKey, checkProviderKeyHealth, setPrimaryProviderKey } from "./provider-keys.js";
import { createCustomProvider, editCustomProvider, listCustomProviders, deleteCustomProvider } from "./custom-providers.js";
import { listProviderCatalog } from "./provider-catalog.js";
import { fetchAvailableModels } from "./model-fetch.js";
import type { ProviderName } from "./providers.js";

/**
 * Update 4: "Dave must be able to, as real callable tools not just
 * admin-UI: create a brand new custom provider (endpoint+key), edit an
 * EXISTING provider's endpoint/config" -- same `ToolDefinition` shape
 * as every other tool manifest in this repo (Step 10's TRADING_TOOLS,
 * Step 22's RFEED_TOOLS).
 */

export interface ProviderToolContext {
  userId: string;
  db: DaveDatabase;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: ProviderToolContext) => Promise<unknown>;
}

export const PROVIDER_TOOLS: ToolDefinition[] = [
  {
    name: "list_providers",
    description: "List every known LLM provider (built-in catalog + your own custom providers), so you know what's available before adding a key or creating a new one.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => ({
      builtIn: listProviderCatalog().map((p) => ({ id: p.id, displayName: p.displayName, openAICompatible: p.openAICompatible })),
      custom: listCustomProviders(ctx.db, ctx.userId).map((p) => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, model: p.model })),
    }),
  },
  {
    name: "add_provider_key",
    description: "Store a real API key for a built-in provider (up to 10 per provider). Optionally override its base URL or model.",
    parameters: {
      type: "object",
      properties: {
        provider: { type: "string", description: "A built-in provider id, e.g. \"openai\", \"groq\", \"nvidia-nim\"." },
        label: { type: "string" },
        apiKey: { type: "string" },
        model: { type: "string" },
        baseUrlOverride: { type: "string" },
        accountId: { type: "string", description: "Cloudflare only." },
        region: { type: "string", description: "Bedrock only." },
        secretAccessKey: { type: "string", description: "Bedrock only." },
      },
      required: ["provider", "label", "apiKey"],
    },
    execute: async (args, ctx) =>
      addProviderKey(ctx.db, ctx.userId, args.provider as ProviderName, args.label as string, {
        apiKey: args.apiKey as string,
        model: args.model as string | undefined,
        baseUrlOverride: args.baseUrlOverride as string | undefined,
        accountId: args.accountId as string | undefined,
        region: args.region as string | undefined,
        secretAccessKey: args.secretAccessKey as string | undefined,
      }),
  },
  {
    name: "edit_provider_key",
    description: "Edit an EXISTING stored key's endpoint/config -- e.g. point it at a proxy, switch its model, or relabel it -- without losing its health history.",
    parameters: {
      type: "object",
      properties: {
        keyId: { type: "string" },
        label: { type: "string" },
        apiKey: { type: "string" },
        model: { type: "string" },
        baseUrlOverride: { type: "string" },
      },
      required: ["keyId"],
    },
    execute: async (args, ctx) =>
      editProviderKey(ctx.db, ctx.userId, args.keyId as string, {
        label: args.label as string | undefined,
        config: {
          ...(args.apiKey !== undefined ? { apiKey: args.apiKey as string } : {}),
          ...(args.model !== undefined ? { model: args.model as string } : {}),
          ...(args.baseUrlOverride !== undefined ? { baseUrlOverride: args.baseUrlOverride as string } : {}),
        },
      }),
  },
  {
    name: "remove_provider_key",
    description: "Delete a stored provider key.",
    parameters: { type: "object", properties: { keyId: { type: "string" } }, required: ["keyId"] },
    execute: async (args, ctx) => ({ removed: removeProviderKey(ctx.db, ctx.userId, args.keyId as string) }),
  },
  {
    name: "list_provider_keys",
    description: "List stored keys for a provider (or all providers), including real health status.",
    parameters: { type: "object", properties: { provider: { type: "string" } } },
    execute: async (args, ctx) => listProviderKeys(ctx.db, ctx.userId, args.provider as ProviderName | undefined),
  },
  {
    name: "add_provider_keys_bulk",
    description: "Paste multiple API keys for one provider at once (one per line, up to 10 total per provider). Each line is validated and stored individually -- one bad key never blocks the rest.",
    parameters: {
      type: "object",
      properties: {
        provider: { type: "string" },
        labelPrefix: { type: "string", description: "Each stored key is labeled \"<labelPrefix> <n>\"." },
        rawKeys: { type: "string", description: "Newline-separated API keys." },
      },
      required: ["provider", "labelPrefix", "rawKeys"],
    },
    execute: async (args, ctx) => addProviderKeysBulk(ctx.db, ctx.userId, args.provider as ProviderName, args.labelPrefix as string, args.rawKeys as string),
  },
  {
    name: "set_primary_provider_key",
    description: "Mark one stored key as the main/default key for its provider -- auto-failover always tries the primary key first (while healthy) before any other stored key for that same provider.",
    parameters: { type: "object", properties: { keyId: { type: "string" } }, required: ["keyId"] },
    execute: async (args, ctx) => setPrimaryProviderKey(ctx.db, ctx.userId, args.keyId as string),
  },
  {
    name: "fetch_provider_models",
    description: "Fetch the real list of available models for a stored key, when that provider supports auto-fetch (manual model-ID entry is required instead for OpenRouter, OrcaRouter, and HuggingFace).",
    parameters: { type: "object", properties: { keyId: { type: "string" }, provider: { type: "string" } }, required: ["keyId", "provider"] },
    execute: async (args, ctx) => {
      const keys = listProviderKeys(ctx.db, ctx.userId, args.provider as ProviderName);
      const key = keys.find((k) => k.id === args.keyId);
      if (!key) throw new Error(`no stored key "${args.keyId}" for provider "${args.provider}"`);
      return fetchAvailableModels(key.provider, key.config);
    },
  },
  {
    name: "check_provider_key_health",
    description: "Run a real health check (a minimal real completion request) against one stored key right now.",
    parameters: { type: "object", properties: { keyId: { type: "string" }, provider: { type: "string" } }, required: ["keyId", "provider"] },
    execute: async (args, ctx) => {
      const keys = listProviderKeys(ctx.db, ctx.userId, args.provider as ProviderName);
      const key = keys.find((k) => k.id === args.keyId);
      if (!key) throw new Error(`no stored key "${args.keyId}" for provider "${args.provider}"`);
      const healthy = await checkProviderKeyHealth(ctx.db, ctx.userId, key);
      return { healthy };
    },
  },
  {
    name: "create_custom_provider",
    description: "Create a brand-new custom LLM provider -- your own endpoint + key -- not one of the built-in catalog entries. Assumed OpenAI-compatible chat-completions shape.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        baseUrl: { type: "string" },
        apiKey: { type: "string" },
        model: { type: "string" },
        chatPath: { type: "string" },
      },
      required: ["name", "baseUrl", "apiKey", "model"],
    },
    execute: async (args, ctx) =>
      createCustomProvider(ctx.db, ctx.userId, {
        name: args.name as string,
        baseUrl: args.baseUrl as string,
        apiKey: args.apiKey as string,
        model: args.model as string,
        chatPath: args.chatPath as string | undefined,
      }),
  },
  {
    name: "edit_custom_provider",
    description: "Edit an EXISTING custom provider's endpoint/config.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        baseUrl: { type: "string" },
        apiKey: { type: "string" },
        model: { type: "string" },
        chatPath: { type: "string" },
      },
      required: ["id"],
    },
    execute: async (args, ctx) =>
      editCustomProvider(ctx.db, ctx.userId, args.id as string, {
        name: args.name as string | undefined,
        baseUrl: args.baseUrl as string | undefined,
        apiKey: args.apiKey as string | undefined,
        model: args.model as string | undefined,
        chatPath: args.chatPath as string | undefined,
      }),
  },
  {
    name: "delete_custom_provider",
    description: "Delete a custom provider.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    execute: async (args, ctx) => ({ removed: deleteCustomProvider(ctx.db, ctx.userId, args.id as string) }),
  },
];
