import { registerScheduledTrigger, unregisterScheduledTrigger, type ScheduledTrigger } from "@dave/db";
import type { DaveDatabase } from "@dave/db";

/**
 * Step 21.1: update/morning brief -- a real Off/On/Custom toggle, DB-
 * backed per user (Step 16), driving a real Step 16.2a scheduled
 * trigger the same way Steps 18/19 already do for their own crons.
 * "On" uses a sane default daily time; "Custom" requires the user's
 * own cron expression -- never silently falls back to the default if
 * they picked Custom without actually giving one.
 */

export type BriefMode = "off" | "on" | "custom";

export const DEFAULT_BRIEF_CRON = "0 7 * * *"; // daily 07:00 UTC

interface SettingsRow {
  id: string;
  mode: BriefMode;
  cron_expression: string | null;
}

const TABLE = "morning_brief_settings";

function ensureTable(db: DaveDatabase): void {
  db.createTable(TABLE, [
    { name: "mode", type: "TEXT" },
    { name: "cron_expression", type: "TEXT" },
  ]);
}

function getOrCreateSettings(db: DaveDatabase, ownerUserId: string): SettingsRow {
  ensureTable(db);
  const rows = db.query(TABLE, ownerUserId, {}) as unknown as SettingsRow[];
  if (rows.length > 0) return rows[0];
  const id = db.insert(TABLE, ownerUserId, { mode: "off" satisfies BriefMode, cron_expression: null });
  return db.getById(TABLE, ownerUserId, id) as unknown as SettingsRow;
}

export function getBriefSettings(db: DaveDatabase, ownerUserId: string): { mode: BriefMode; cronExpression: string | null } {
  const row = getOrCreateSettings(db, ownerUserId);
  return { mode: row.mode, cronExpression: row.cron_expression };
}

export class MissingCustomIntervalError extends Error {
  constructor() {
    super('mode "custom" requires a real cron expression -- it does not silently fall back to the default interval');
    this.name = "MissingCustomIntervalError";
  }
}

export function setBriefMode(db: DaveDatabase, ownerUserId: string, mode: BriefMode, customCronExpression?: string): void {
  const row = getOrCreateSettings(db, ownerUserId);
  if (mode === "custom" && !customCronExpression) throw new MissingCustomIntervalError();
  const cronExpression = mode === "off" ? null : mode === "on" ? DEFAULT_BRIEF_CRON : customCronExpression!;
  db.update(TABLE, ownerUserId, row.id, { mode, cron_expression: cronExpression });
}

/**
 * Call after any settings change (and once on boot) to make the real
 * scheduled trigger match current settings -- registers/re-registers
 * with the right expression when on/custom, unregisters cleanly when off.
 */
export function syncMorningBriefCron(db: DaveDatabase, ownerUserId: string, onBrief: () => void | Promise<void>): ScheduledTrigger | undefined {
  const id = `morning-brief-${ownerUserId}`;
  unregisterScheduledTrigger(id);
  const settings = getBriefSettings(db, ownerUserId);
  if (settings.mode === "off") return undefined;
  return registerScheduledTrigger(id, settings.cronExpression!, onBrief);
}

export function stopMorningBriefCron(ownerUserId: string): void {
  unregisterScheduledTrigger(`morning-brief-${ownerUserId}`);
}
