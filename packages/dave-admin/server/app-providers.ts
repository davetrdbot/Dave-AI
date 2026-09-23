import { DaveDatabase } from "@dave/db";
import { PROVIDER_CATALOG, getModelConfig, listProviderKeys, setModelConfig, type ProviderName } from "@dave/brain";
import { dbPathFor } from "./db-path";

const DEFAULT_PROVIDER: ProviderName = "baseten";

/** A real catalog provider the app may manage. Aliases resolve to another entry, so they are not
 *  managed on their own. Absent means Baseten -- what app builds before multi-provider sent. */
export function resolveAppProvider(raw: string | null | undefined): ProviderName | undefined {
  const id = (raw ?? DEFAULT_PROVIDER).trim() as ProviderName;
  const entry = PROVIDER_CATALOG[id];
  return entry && !entry.aliasOf ? id : undefined;
}

/** Every provider, with how many keys it has and where it sits in Dave's order. Main first, then
 *  backups in order, then providers with keys, then the rest alphabetically. */
export function listAppProviders(userId: string) {
  const config = getModelConfig(userId);
  const backups = config.fallback.filter((p) => p !== config.primary);
  const db = new DaveDatabase(dbPathFor(userId));
  let keys: ReturnType<typeof listProviderKeys> = [];
  try {
    keys = listProviderKeys(db, userId);
  } finally {
    db.close();
  }
  const rows = Object.values(PROVIDER_CATALOG)
    .filter((e) => !e.aliasOf)
    .map((e) => {
      const own = keys.filter((k) => k.provider === e.id);
      const backupIndex = backups.indexOf(e.id);
      return {
        provider: e.id,
        name: e.displayName,
        keyCount: own.length,
        healthyKeys: own.filter((k) => k.healthy).length,
        model: (own.find((k) => k.isPrimary) ?? own[0])?.config.model ?? e.defaultModel,
        isPrimary: config.primary === e.id,
        backupPosition: backupIndex === -1 ? null : backupIndex + 1,
      };
    });
  const rank = (r: (typeof rows)[number]) => (r.isPrimary ? 0 : r.backupPosition !== null ? r.backupPosition : r.keyCount > 0 ? 1000 : 2000);
  rows.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return { primary: config.primary, backups, providers: rows };
}

/** Moves a backup one place earlier or later in the order Dave tries them. */
export function moveBackup(userId: string, provider: ProviderName, direction: "up" | "down"): void {
  const config = getModelConfig(userId);
  const backups = config.fallback.filter((p) => p !== config.primary);
  const i = backups.indexOf(provider);
  const j = direction === "up" ? i - 1 : i + 1;
  if (i === -1 || j < 0 || j >= backups.length) return;
  [backups[i], backups[j]] = [backups[j], backups[i]];
  setModelConfig(userId, { primary: config.primary, fallback: backups });
}
