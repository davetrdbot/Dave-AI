import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomInt } from "node:crypto";

export type PairingStatus = "pending" | "paired" | "rejected";

export interface PairingRecord {
  userId: string;
  code: string;
  status: PairingStatus;
  requestedAt: number;
  decidedAt?: number;
}

function storePath(): string {
  return join(process.cwd(), "data", "pairing.json");
}

function loadAll(): Record<string, PairingRecord> {
  const path = storePath();
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveAll(records: Record<string, PairingRecord>): void {
  const path = storePath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(records, null, 2), "utf8");
}

function generateCode(): string {
  return String(randomInt(100000, 999999));
}

/**
 * Handles a message from a userId Dave has never seen before. Per Step
 * 3.5: Dave starts unconfigured, and the very first message from a new
 * user gets back their user ID and a pairing code — nothing else happens
 * until the owner approves.
 */
export function requestPairing(userId: string): PairingRecord {
  const records = loadAll();
  const existing = records[userId];
  if (existing) return existing;

  const record: PairingRecord = {
    userId,
    code: generateCode(),
    status: "pending",
    requestedAt: Date.now(),
  };
  records[userId] = record;
  saveAll(records);
  return record;
}

/** The owner approves a pending pairing request by user ID or code. */
export function approvePairing(userIdOrCode: string): PairingRecord {
  const records = loadAll();
  const record =
    records[userIdOrCode] ?? Object.values(records).find((r) => r.code === userIdOrCode);
  if (!record) throw new Error(`No pairing request found for "${userIdOrCode}"`);
  if (record.status !== "pending") {
    throw new Error(`Pairing request for ${record.userId} is already "${record.status}", not pending`);
  }
  record.status = "paired";
  record.decidedAt = Date.now();
  records[record.userId] = record;
  saveAll(records);
  return record;
}

export function rejectPairing(userIdOrCode: string): PairingRecord {
  const records = loadAll();
  const record =
    records[userIdOrCode] ?? Object.values(records).find((r) => r.code === userIdOrCode);
  if (!record) throw new Error(`No pairing request found for "${userIdOrCode}"`);
  record.status = "rejected";
  record.decidedAt = Date.now();
  records[record.userId] = record;
  saveAll(records);
  return record;
}

export function getPairingStatus(userId: string): PairingStatus | "unknown" {
  const records = loadAll();
  return records[userId]?.status ?? "unknown";
}

export function isPaired(userId: string): boolean {
  return getPairingStatus(userId) === "paired";
}
