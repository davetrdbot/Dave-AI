import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * "Is my idea still valid?" — the Self-Awareness spec, part 2.
 *
 * As a trade develops, the original thesis is periodically re-evaluated against current market
 * conditions and classified into one of four states. When the state CHANGES, that's the event worth
 * alerting on, together with what changed. This store holds the current state per ticket and detects
 * the change; the actual judgement (reading fresh analysis and deciding which state applies) is the
 * agent's, made via the update_trade_thesis tool during its cycles or a background check -- a price
 * comparison can't judge whether a thesis still holds, only a look at the chart can.
 */

export type ThesisStatus = "still_valid" | "weakening" | "invalidated" | "recovering";

export const THESIS_STATUSES: ThesisStatus[] = ["still_valid", "weakening", "invalidated", "recovering"];

export interface ThesisStatusRecord {
  ticket: string;
  symbol: string;
  status: ThesisStatus;
  /** What changed at the last transition -- surfaced with the alert. */
  note?: string;
  updatedAt: number;
  history: { status: ThesisStatus; note?: string; at: number }[];
}

export const MAX_RETAINED_THESIS = 200;

function thesisPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "thesis-status.json");
}

function readAll(userId: string): ThesisStatusRecord[] {
  const path = thesisPath(userId);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? (parsed as ThesisStatusRecord[]) : [];
  } catch {
    return [];
  }
}

function writeAll(userId: string, records: ThesisStatusRecord[]): void {
  const path = thesisPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(records.slice(-MAX_RETAINED_THESIS), null, 2), "utf8");
}

export class InvalidThesisStatusError extends Error {
  constructor(status: string) {
    super(`"${status}" is not a valid thesis status. Use one of: ${THESIS_STATUSES.join(", ")}.`);
    this.name = "InvalidThesisStatusError";
  }
}

/**
 * Sets the current thesis status for a ticket. Returns whether it CHANGED from the previous status
 * (the caller alerts only on a change), along with the previous status. Idempotent: setting the same
 * status again is not a change and does not spam the history.
 */
export function setThesisStatus(
  userId: string,
  input: { ticket: string; symbol: string; status: ThesisStatus; note?: string }
): { changed: boolean; previous?: ThesisStatus; record: ThesisStatusRecord } {
  if (!THESIS_STATUSES.includes(input.status)) throw new InvalidThesisStatusError(input.status);
  const all = readAll(userId);
  const existing = all.find((r) => r.ticket === input.ticket);
  const previous = existing?.status;
  const changed = previous !== input.status;

  const record: ThesisStatusRecord = existing ?? {
    ticket: input.ticket,
    symbol: input.symbol,
    status: input.status,
    updatedAt: Date.now(),
    history: [],
  };
  record.symbol = input.symbol || record.symbol;
  if (changed) {
    record.status = input.status;
    record.note = input.note;
    record.updatedAt = Date.now();
    record.history.push({ status: input.status, note: input.note, at: record.updatedAt });
  }

  writeAll(userId, [...all.filter((r) => r.ticket !== input.ticket), record]);
  return { changed, previous, record };
}

export function getThesisStatus(userId: string, ticket: string): ThesisStatusRecord | undefined {
  return readAll(userId).find((r) => r.ticket === ticket);
}

export function listThesisStatuses(userId: string): ThesisStatusRecord[] {
  return readAll(userId);
}

/** A short, human label for a status, for alert text. */
export function thesisStatusLabel(status: ThesisStatus): string {
  switch (status) {
    case "still_valid":
      return "✅ Still valid";
    case "weakening":
      return "🟡 Weakening";
    case "invalidated":
      return "🔴 Invalidated";
    case "recovering":
      return "🟢 Recovering";
  }
}
