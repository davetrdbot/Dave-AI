import { NextResponse } from "next/server";
import { DaveDatabase } from "@dave/db";
import {
  PROVIDER_CATALOG,
  addProviderKey,
  keyLineConfig,
  checkProviderKeyHealth,
  editProviderKey,
  fetchAvailableModels,
  getModelConfig,
  listProviderKeys,
  removeProviderKey,
  setModelConfig,
  setPrimaryProviderKey,
  type ProviderKeyConfig,
  type ProviderName,
} from "@dave/brain";
import { withDevice } from "../../../../server/require-device";
import { dbPathFor } from "../../../../server/db-path";
import { maskSecret } from "../../../../server/mask-secret";
import { resolveAppProvider } from "../../../../server/app-providers";

/**
 * One AI provider, managed from the phone: its keys, the model, and where it sits in Dave's order
 * (main, backup, or unused).
 *
 * Originally Baseten-only by the trader's choice; now every provider in the catalog (the trader:
 * "add all the providers to the settings"). `provider` comes from `?provider=` or the JSON body and
 * defaults to Baseten, so an app build from before this change keeps working unchanged.
 *
 * Keys are the same rows the bot rotates through (provider_keys), so a key added here joins the
 * failover pool immediately. Real keys never leave the server: only masked forms are returned.
 */

/** A pasted address, cleaned: https only (http for a local test server), no trailing slash, and
 *  no /chat/completions on the end (people often paste the full endpoint). Undefined if unusable. */
function normalizeBaseUrl(raw: string | undefined): string | undefined {
  let value = raw?.trim();
  if (!value) return undefined;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  value = value.replace(/\/+$/, "").replace(/\/chat\/completions$/i, "").replace(/\/+$/, "");
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(url.hostname))) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function withDb<T>(userId: string, fn: (db: DaveDatabase) => T): T {
  const db = new DaveDatabase(dbPathFor(userId));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function describe(userId: string, db: DaveDatabase, provider: ProviderName) {
  const config = getModelConfig(userId);
  const entry = PROVIDER_CATALOG[provider];
  const backupIndex = config.fallback.filter((p) => p !== config.primary).indexOf(provider);
  return {
    provider,
    name: entry.displayName,
    defaultModel: entry.defaultModel,
    manualModelEntry: entry.manualModelEntry || !entry.modelsPath,
    requiresExtraConfig: entry.requiresExtraConfig ?? [],
    notes: entry.notes,
    isPrimary: config.primary === provider,
    backupPosition: config.primary === provider || backupIndex === -1 ? null : backupIndex + 1,
    // Custom (OpenAI-compatible): every connection carries its own web address and model.
    isCustom: provider === "custom",
    keys: listProviderKeys(db, userId, provider).map((k) => ({
      id: k.id,
      label: k.label,
      baseUrl: k.config.baseUrlOverride ?? null,
      maskedKey: maskSecret(k.config.apiKey),
      model: k.config.model ?? entry.defaultModel,
      healthy: k.healthy,
      isPrimary: k.isPrimary,
      lastError: k.lastError,
      lastCheckedAt: k.lastCheckedAt,
    })),
  };
}

export const GET = withDevice(async ({ userId, req }) => {
  const provider = resolveAppProvider(req.nextUrl.searchParams.get("provider"));
  if (!provider) return NextResponse.json({ error: "Unknown provider." }, { status: 404 });
  return NextResponse.json(withDb(userId, (db) => describe(userId, db, provider)));
});

export const POST = withDevice(async ({ userId, req }) => {
  let body: {
    provider?: string;
    action?: string;
    apiKey?: string;
    label?: string;
    model?: string;
    keyId?: string;
    accountId?: string;
    region?: string;
    secretAccessKey?: string;
    baseUrl?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const provider = resolveAppProvider(body.provider ?? req.nextUrl.searchParams.get("provider"));
  if (!provider) return NextResponse.json({ error: "Unknown provider." }, { status: 404 });
  const entry = PROVIDER_CATALOG[provider];

  const db = new DaveDatabase(dbPathFor(userId));
  try {
    const own = (id: string | undefined) => (id ? listProviderKeys(db, userId, provider).find((k) => k.id === id) : undefined);
    const notFound = () => NextResponse.json({ error: `No such ${entry.displayName} key.` }, { status: 404 });
    switch (body.action) {
      case "add-key": {
        const apiKey = body.apiKey?.trim();
        if (!apiKey) return NextResponse.json({ error: `Paste a ${entry.displayName} API key.` }, { status: 400 });
        // A key line may carry more than the key (Bedrock: "KEY eu-west-1").
        const config: ProviderKeyConfig = keyLineConfig(provider, apiKey);
        if (provider === "bedrock") {
          if (body.region?.trim()) config.region = body.region.trim();
          if (body.secretAccessKey?.trim()) config.secretAccessKey = body.secretAccessKey.trim();
        }
        if (provider === "custom") {
          // Any OpenAI-compatible service: its web address, a key and a model -- each connection
          // its own (they fail over to each other like the keys of any provider).
          const baseUrl = normalizeBaseUrl(body.baseUrl);
          if (!baseUrl) return NextResponse.json({ error: "Enter the provider's web address (base URL), like https://api.example.com/v1" }, { status: 400 });
          const model = body.model?.trim();
          if (!model) return NextResponse.json({ error: "Enter the model id to use with this provider." }, { status: 400 });
          config.baseUrlOverride = baseUrl;
          config.model = model;
          addProviderKey(db, userId, provider, body.label?.trim() || new URL(baseUrl).hostname, config);
          break;
        }
        // Every key of a provider shares one model: rotation must not silently switch models.
        const model = body.model?.trim() || listProviderKeys(db, userId, provider)[0]?.config.model;
        if (model) config.model = model;
        for (const extra of entry.requiresExtraConfig ?? []) {
          const value = body[extra]?.trim();
          if (!value) return NextResponse.json({ error: `${entry.displayName} also needs ${extra}.` }, { status: 400 });
          config[extra] = value;
        }
        addProviderKey(db, userId, provider, body.label?.trim() || `${entry.displayName} ${listProviderKeys(db, userId, provider).length + 1}`, config);
        break;
      }
      case "remove-key": {
        if (!own(body.keyId)) return notFound();
        removeProviderKey(db, userId, body.keyId!);
        break;
      }
      case "make-primary-key": {
        if (!own(body.keyId)) return notFound();
        setPrimaryProviderKey(db, userId, body.keyId!);
        break;
      }
      case "set-model": {
        const model = body.model?.trim();
        if (!model) return NextResponse.json({ error: "Enter a model id." }, { status: 400 });
        // A custom connection's model is its own (keyId given); otherwise all keys share one.
        const targets = provider === "custom" && body.keyId ? [own(body.keyId)].filter((k) => k !== undefined) : listProviderKeys(db, userId, provider);
        if (!targets.length) return notFound();
        for (const k of targets) editProviderKey(db, userId, k.id, { config: { model } });
        break;
      }
      case "check-key": {
        const key = own(body.keyId);
        if (!key) return notFound();
        await checkProviderKeyHealth(db, userId, key);
        break;
      }
      case "models": {
        // The provider's own model list, fetched with a stored key -- returned without changing anything.
        const key = listProviderKeys(db, userId, provider)[0];
        if (!key) return NextResponse.json({ error: `Add a ${entry.displayName} key first.` }, { status: 400 });
        const result = await fetchAvailableModels(provider, key.config);
        return NextResponse.json({ models: result.models, manualEntryRequired: result.manualEntryRequired, error: result.error ? "The provider refused the model list." : undefined });
      }
      // "use-baseten" is the name older app builds send.
      case "use-baseten":
      case "make-main": {
        if (listProviderKeys(db, userId, provider).length === 0) return NextResponse.json({ error: `Add a ${entry.displayName} key before making it Dave's main AI.` }, { status: 400 });
        const current = getModelConfig(userId);
        // The old main becomes the first backup, so nothing Dave had working is dropped.
        const fallback = [current.primary, ...current.fallback].filter((p) => p !== provider);
        setModelConfig(userId, { primary: provider, fallback: [...new Set(fallback)] });
        break;
      }
      case "add-backup": {
        const current = getModelConfig(userId);
        if (current.primary === provider) return NextResponse.json({ error: `${entry.displayName} is already the main AI.` }, { status: 400 });
        if (listProviderKeys(db, userId, provider).length === 0) return NextResponse.json({ error: `Add a ${entry.displayName} key first.` }, { status: 400 });
        setModelConfig(userId, { primary: current.primary, fallback: [...new Set([...current.fallback, provider])] });
        break;
      }
      case "remove-backup": {
        const current = getModelConfig(userId);
        setModelConfig(userId, { primary: current.primary, fallback: current.fallback.filter((p) => p !== provider) });
        break;
      }
      default:
        return NextResponse.json(
          { error: "action must be one of: add-key, remove-key, make-primary-key, set-model, check-key, models, make-main, add-backup, remove-backup." },
          { status: 400 },
        );
    }
    return NextResponse.json(describe(userId, db, provider));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  } finally {
    db.close();
  }
});
