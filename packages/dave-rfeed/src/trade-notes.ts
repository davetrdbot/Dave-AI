import type { DaveDatabase } from "@dave/db";

/**
 * R_Feed safety rule: the MT5 comment field stays short (the user's
 * short ID, ~31 real MT5 chars max) -- the full strategy note lives
 * here instead, in the real DB (Step 16), linked by the trade's real
 * MT5 ticket number once it comes back from the EA.
 */

const TABLE = "rfeed_trade_notes";

function ensureTable(db: DaveDatabase): void {
  db.createTable(TABLE, [
    { name: "ticket", type: "TEXT" },
    { name: "note", type: "TEXT" },
  ]);
}

export function recordTradeNote(db: DaveDatabase, ownerUserId: string, ticket: string, note: string): string {
  ensureTable(db);
  return db.insert(TABLE, ownerUserId, { ticket, note });
}

export function getTradeNote(db: DaveDatabase, ownerUserId: string, ticket: string): string | undefined {
  ensureTable(db);
  const rows = db.query(TABLE, ownerUserId, { ticket }) as unknown as { note: string }[];
  return rows[0]?.note;
}
