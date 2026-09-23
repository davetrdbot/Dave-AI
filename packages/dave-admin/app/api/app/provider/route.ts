import { NextResponse } from "next/server";
import { DaveDatabase } from "@dave/db";
import {
  PROVIDER_CATALOG,
  addProviderKey,
  checkProviderKeyHealth,
  editProviderKey,
  getModelConfig,
  listProviderKeys,
  removeProviderKey,
  setModelConfig,
  setPrimaryProviderKey,
} from "@dave/brain";
import { withDevice } from "../../../../server/require-device";
import { dbPathFor } from "../../../../server/db-path";
import { maskSecret } from "../../../../server/mask-secret";

/**
 * Baseten, and only Baseten -- the one AI provider the app manages, by the trader's choice. The
 * web panel keeps the full multi-provider screen; the phone gets the short version.
 *
 * Keys are the same rows the bot rotates through (provider_keys), so a key added here joins the
 * failover pool immediately. Real keys never leave the server: only masked forms are returned.
 */

const PROVIDER = "baseten" as const;

function withDb<T>(userId: string, fn: (db: DaveDatabase) => T): T {
  const db = new DaveDatabase(dbPathFor(userId));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function describe(userId: string, db: DaveDatabase) {
  const config = getModelConfig(userId);
  return {
    provider: PROVIDER,
    name: PROVIDER_CATALOG[PROVIDER].displayName,
    defaultModel: PROVIDER_CATALOG[PROVIDER].defaultModel,
    isPrimary: config.primary === PROVIDER,
    keys: listProviderKeys(db, userId, PROVIDER).map((k) => ({
      id: k.id,
      label: k.label,
      maskedKey: maskSecret(k.config.apiKey),
      model: k.config.model ?? PROVIDER_CATALOG[PROVIDER].defaultModel,
      healthy: k.healthy,
      isPrimary: k.isPrimary,
      lastError: k.lastError,
      lastCheckedAt: k.lastCheckedAt,
    })),
  };
}

export const GET = withDevice(async ({ userId }) => NextResponse.json(withDb(userId, (db) => describe(userId, db))));

export const POST = withDevice(async ({ userId, req }) => {
  let body: { action?: string; apiKey?: string; label?: string; model?: string; keyId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const db = new DaveDatabase(dbPathFor(userId));
  try {
    const own = (id: string | undefined) => (id ? listProviderKeys(db, userId, PROVIDER).find((k) => k.id === id) : undefined);
    switch (body.action) {
      case "add-key": {
        const apiKey = body.apiKey?.trim();
        if (!apiKey) return NextResponse.json({ error: "Paste a Baseten API key." }, { status: 400 });
        const model = body.model?.trim() || undefined;
        addProviderKey(db, userId, PROVIDER, body.label?.trim() || `Baseten ${listProviderKeys(db, userId, PROVIDER).length + 1}`, { apiKey, model });
        break;
      }
      case "remove-key": {
        if (!own(body.keyId)) return NextResponse.json({ error: "No such Baseten key." }, { status: 404 });
        removeProviderKey(db, userId, body.keyId!);
        break;
      }
      case "make-primary-key": {
        if (!own(body.keyId)) return NextResponse.json({ error: "No such Baseten key." }, { status: 404 });
        setPrimaryProviderKey(db, userId, body.keyId!);
        break;
      }
      case "set-model": {
        // One model for every Baseten key: rotation between keys must not silently switch models.
        const model = body.model?.trim();
        if (!model) return NextResponse.json({ error: "Enter a model id." }, { status: 400 });
        for (const k of listProviderKeys(db, userId, PROVIDER)) editProviderKey(db, userId, k.id, { config: { model } });
        break;
      }
      case "check-key": {
        const key = own(body.keyId);
        if (!key) return NextResponse.json({ error: "No such Baseten key." }, { status: 404 });
        await checkProviderKeyHealth(db, userId, key);
        break;
      }
      case "use-baseten": {
        const current = getModelConfig(userId);
        const fallback = [current.primary, ...current.fallback].filter((p) => p !== PROVIDER);
        setModelConfig(userId, { primary: PROVIDER, fallback: [...new Set(fallback)] });
        break;
      }
      default:
        return NextResponse.json({ error: "action must be one of: add-key, remove-key, make-primary-key, set-model, check-key, use-baseten." }, { status: 400 });
    }
    return NextResponse.json(describe(userId, db));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  } finally {
    db.close();
  }
});
