import type { DaveDatabase } from "@dave/db";

/**
 * Update 5: "Settings fields: 'Lovable MCP URL' and 'Lovable MCP
 * Token', user enters own values, nothing hardcoded ... token will
 * rotate, UI must support updating it anytime, not a one-time
 * hardcoded value." Real DB-backed settings, Step 16 pattern -- no
 * default URL/token baked in anywhere in code, both start unset.
 */
const TABLE = "lovable_mcp_settings";

export interface LovableMcpSettings {
  url: string | null;
  token: string | null;
}

function ensureTable(db: DaveDatabase): void {
  db.createTable(TABLE, [
    { name: "url", type: "TEXT" },
    { name: "token", type: "TEXT" },
  ]);
}

export function getLovableMcpSettings(db: DaveDatabase, userId: string): LovableMcpSettings {
  ensureTable(db);
  const rows = db.query(TABLE, userId, {});
  if (rows.length === 0) return { url: null, token: null };
  return { url: (rows[0].url as string | null) ?? null, token: (rows[0].token as string | null) ?? null };
}

/** Real update-anytime support -- rotating the token is a normal, expected call, not a one-time setup. */
export function setLovableMcpSettings(db: DaveDatabase, userId: string, settings: LovableMcpSettings): void {
  ensureTable(db);
  const rows = db.query(TABLE, userId, {});
  if (rows.length === 0) {
    db.insert(TABLE, userId, { url: settings.url, token: settings.token });
  } else {
    db.update(TABLE, userId, rows[0].id as string, { url: settings.url, token: settings.token });
  }
}
