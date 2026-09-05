import type { DaveDatabase } from "@dave/db";

/** Part 3 (B6): Green API instance credentials, stored the same secure way as other provider keys -- one instance per user (this is the user's own WhatsApp Business number, not a multi-key failover set). */
const TABLE = "greenapi_credentials";

export interface GreenApiCredentials {
  idInstance: string;
  apiTokenInstance: string;
}

function ensureTable(db: DaveDatabase): void {
  db.createTable(TABLE, [
    { name: "id_instance", type: "TEXT" },
    { name: "api_token_instance", type: "TEXT" },
  ]);
}

export function setGreenApiCredentials(db: DaveDatabase, userId: string, creds: GreenApiCredentials): void {
  ensureTable(db);
  const existing = db.query(TABLE, userId, {});
  if (existing.length > 0) {
    db.update(TABLE, userId, existing[0].id as string, { id_instance: creds.idInstance, api_token_instance: creds.apiTokenInstance });
  } else {
    db.insert(TABLE, userId, { id_instance: creds.idInstance, api_token_instance: creds.apiTokenInstance });
  }
}

export function getGreenApiCredentials(db: DaveDatabase, userId: string): GreenApiCredentials | undefined {
  ensureTable(db);
  const rows = db.query(TABLE, userId, {});
  if (rows.length === 0) return undefined;
  return { idInstance: rows[0].id_instance as string, apiTokenInstance: rows[0].api_token_instance as string };
}
