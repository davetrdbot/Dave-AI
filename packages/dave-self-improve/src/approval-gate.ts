import type { DaveDatabase } from "@dave/db";

/**
 * Step 17.4/17.5: every risky change asks explicitly, never silently.
 * The exact prompt shape is the master prompt's own template, not a
 * paraphrase: "I need to do X. Reason: [why]. Yes or No?" -- callers
 * (Telegram, a worker, whatever surface) send `promptText` verbatim and
 * report the user's answer back via `decideApproval`.
 *
 * Auto-approval is a real per-user toggle, defaults OFF -- a fresh user
 * genuinely gets asked every time until they explicitly turn it on.
 *
 * Declined proposals are remembered (17.5): re-requesting the exact
 * same description with the exact same reason is refused outright
 * rather than re-asking -- only a genuinely NEW reason gets a new
 * prompt. This is real enforcement in the write path, not a UI nicety.
 */

export type ApprovalKind = "patch" | "tool-creation" | "strategy-change" | string;
export type ApprovalStatus = "pending" | "approved" | "declined";

export interface ApprovalRequest {
  id: string;
  kind: ApprovalKind;
  description: string;
  reason: string;
  status: ApprovalStatus;
  promptText: string;
}

interface ApprovalRow {
  id: string;
  kind: ApprovalKind;
  description: string;
  reason: string;
  status: ApprovalStatus;
  prompt_text: string;
}

interface SettingsRow {
  id: string;
  auto_approve: number;
}

const REQUESTS_TABLE = "approval_requests";
const SETTINGS_TABLE = "approval_settings";

function ensureTables(db: DaveDatabase): void {
  db.createTable(REQUESTS_TABLE, [
    { name: "kind", type: "TEXT" },
    { name: "description", type: "TEXT" },
    { name: "reason", type: "TEXT" },
    { name: "status", type: "TEXT" },
    { name: "prompt_text", type: "TEXT" },
  ]);
  db.createTable(SETTINGS_TABLE, [{ name: "auto_approve", type: "INTEGER" }]);
}

export class DeclinedWithoutNewJustificationError extends Error {
  constructor(description: string, reason: string) {
    super(`"${description}" was already declined with this exact reason ("${reason}") -- a new proposal needs new justification, not a re-ask`);
    this.name = "DeclinedWithoutNewJustificationError";
  }
}

export function getAutoApproveEnabled(db: DaveDatabase, ownerUserId: string): boolean {
  ensureTables(db);
  const rows = db.query(SETTINGS_TABLE, ownerUserId, {}) as unknown as SettingsRow[];
  return rows.length > 0 ? rows[0].auto_approve === 1 : false; // defaults off
}

export function setAutoApproveEnabled(db: DaveDatabase, ownerUserId: string, enabled: boolean): void {
  ensureTables(db);
  const rows = db.query(SETTINGS_TABLE, ownerUserId, {}) as unknown as SettingsRow[];
  if (rows.length > 0) db.update(SETTINGS_TABLE, ownerUserId, rows[0].id, { auto_approve: enabled ? 1 : 0 });
  else db.insert(SETTINGS_TABLE, ownerUserId, { auto_approve: enabled ? 1 : 0 });
}

function toRequest(row: ApprovalRow): ApprovalRequest {
  return { id: row.id, kind: row.kind, description: row.description, reason: row.reason, status: row.status, promptText: row.prompt_text };
}

export function requestApproval(db: DaveDatabase, ownerUserId: string, kind: ApprovalKind, description: string, reason: string): ApprovalRequest {
  ensureTables(db);

  const priorDeclines = db.query(REQUESTS_TABLE, ownerUserId, { description, status: "declined" }) as unknown as ApprovalRow[];
  if (priorDeclines.some((r) => r.reason === reason)) {
    throw new DeclinedWithoutNewJustificationError(description, reason);
  }

  const promptText = `I need to do ${description}. Reason: ${reason}. Yes or No?`;
  const autoApprove = getAutoApproveEnabled(db, ownerUserId);
  const status: ApprovalStatus = autoApprove ? "approved" : "pending";
  const id = db.insert(REQUESTS_TABLE, ownerUserId, { kind, description, reason, status, prompt_text: promptText });
  return { id, kind, description, reason, status, promptText };
}

export function decideApproval(db: DaveDatabase, ownerUserId: string, id: string, approved: boolean): ApprovalRequest {
  db.update(REQUESTS_TABLE, ownerUserId, id, { status: approved ? "approved" : "declined" satisfies ApprovalStatus });
  return getApproval(db, ownerUserId, id)!;
}

export function getApproval(db: DaveDatabase, ownerUserId: string, id: string): ApprovalRequest | undefined {
  const row = db.getById(REQUESTS_TABLE, ownerUserId, id) as unknown as ApprovalRow | undefined;
  return row ? toRequest(row) : undefined;
}
