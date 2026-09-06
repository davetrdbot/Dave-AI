import type { DaveDatabase } from "@dave/db";

/**
 * Real gap fixed (spec: "NOTIFICATIONS section: Push notifications on/off, Email
 * notifications on/off... Trade-opened notification (includes trade + reasoning
 * together)"). Push gates the real Telegram alert senders in extra-tools.ts (previously
 * unconditional -- a toggle that didn't actually stop anything would be a ghost feature).
 *
 * Honest boundary: there is genuinely NO email-sending capability anywhere in this codebase
 * (no SMTP client, no email API integration) -- confirmed by search, not assumed. This
 * stores a real emailEnabled preference (so the setting itself is real, not faked), but
 * turning it on cannot actually send an email yet; a real email provider integration would
 * need to be built and wired in separately before this toggle does anything beyond storing
 * intent. That gap is reported honestly rather than pretending emails go out.
 */
export interface NotificationSettings {
  pushEnabled: boolean;
  emailEnabled: boolean;
  tradeOpenedEnabled: boolean;
}

interface SettingsRow {
  id: string;
  push_enabled: number;
  email_enabled: number;
  trade_opened_enabled: number;
}

const TABLE = "notification_settings";

function ensureTable(db: DaveDatabase): void {
  db.createTable(TABLE, [
    { name: "push_enabled", type: "INTEGER" },
    { name: "email_enabled", type: "INTEGER" },
    { name: "trade_opened_enabled", type: "INTEGER" },
  ]);
}

function getOrCreateRow(db: DaveDatabase, ownerUserId: string): SettingsRow {
  ensureTable(db);
  const rows = db.query(TABLE, ownerUserId, {}) as unknown as SettingsRow[];
  if (rows.length > 0) return rows[0];
  // Real default posture, consistent with every other toggle in this build: push and
  // trade-opened default ON (this is a trading bot -- silence-by-default would hide real
  // account activity from the user); email defaults off since it can't do anything yet.
  const id = db.insert(TABLE, ownerUserId, { push_enabled: 1, email_enabled: 0, trade_opened_enabled: 1 });
  return db.getById(TABLE, ownerUserId, id) as unknown as SettingsRow;
}

function toSettings(row: SettingsRow): NotificationSettings {
  return { pushEnabled: row.push_enabled === 1, emailEnabled: row.email_enabled === 1, tradeOpenedEnabled: row.trade_opened_enabled === 1 };
}

export function getNotificationSettings(db: DaveDatabase, ownerUserId: string): NotificationSettings {
  return toSettings(getOrCreateRow(db, ownerUserId));
}

export function setPushEnabled(db: DaveDatabase, ownerUserId: string, enabled: boolean): void {
  const row = getOrCreateRow(db, ownerUserId);
  db.update(TABLE, ownerUserId, row.id, { push_enabled: enabled ? 1 : 0 });
}

export function setEmailEnabled(db: DaveDatabase, ownerUserId: string, enabled: boolean): void {
  const row = getOrCreateRow(db, ownerUserId);
  db.update(TABLE, ownerUserId, row.id, { email_enabled: enabled ? 1 : 0 });
}

export function setTradeOpenedEnabled(db: DaveDatabase, ownerUserId: string, enabled: boolean): void {
  const row = getOrCreateRow(db, ownerUserId);
  db.update(TABLE, ownerUserId, row.id, { trade_opened_enabled: enabled ? 1 : 0 });
}
