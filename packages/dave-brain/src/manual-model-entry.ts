import type { DaveDatabase } from "@dave/db";
import type { ProviderName } from "./providers.js";

/**
 * Real gap fixed: OpenRouter/OrcaRouter/HuggingFace are forced to manual
 * model-ID entry (no clean /models list) -- /models used to just print a
 * static note ("manual model entry (set in admin panel)") with no actual
 * Telegram-side way to set it. This is the persisted "the user's next
 * free-text message IS the model ID for this provider" state that makes
 * that real from the bot itself, not admin-panel-only.
 */
const TABLE = "pending_manual_model_entry";

function ensureTable(db: DaveDatabase): void {
  db.createTable(TABLE, [{ name: "provider", type: "TEXT" }]);
}

export function setPendingManualModelEntry(db: DaveDatabase, userId: string, provider: ProviderName | null): void {
  ensureTable(db);
  const existing = db.query(TABLE, userId, {});
  for (const row of existing) db.deleteRow(TABLE, userId, row.id as string);
  if (provider) db.insert(TABLE, userId, { provider });
}

export function getPendingManualModelEntry(db: DaveDatabase, userId: string): ProviderName | null {
  ensureTable(db);
  const existing = db.query(TABLE, userId, {});
  return existing.length > 0 ? (existing[0].provider as ProviderName) : null;
}
