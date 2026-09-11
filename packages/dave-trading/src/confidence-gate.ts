import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OrderRequest } from "./order-types.js";

/**
 * Real gap fixed (user: "implement confidence rate so when it's placing a trade it should send
 * like the screenshot... and also to set confidence rate in the settings the confidence rate is
 * meaning it's below the confidence rate it should ask you for approval to trade it and also a
 * setting to auto approval trade below the confidence rate"). Confidence is Dave's own real
 * assessed score (0-100) for a specific trade it's about to place -- not invented here, this
 * module only gates on whatever number the caller passes in. Below the user's threshold, the
 * trade is queued for a real approve/decline round trip instead of firing immediately, UNLESS
 * the user has explicitly opted into auto-approval for exactly that case.
 */

export interface ConfidenceSettings {
  threshold: number; // 0-100
  autoApproveBelowThreshold: boolean;
}

// Real gap fixed (user: "remove it the user must set the confidence rate but by default auto
// approve is on by default"). Auto-approval starts ON so a real setup below threshold still
// fires immediately instead of silently queuing forever -- the user can turn it off themselves
// via /settings -> Confidence Rate if they want the approve/decline gate back.
const DEFAULT_CONFIDENCE_SETTINGS: ConfidenceSettings = { threshold: 70, autoApproveBelowThreshold: true };

function confidenceSettingsPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "confidence-settings.json");
}

export function getConfidenceSettings(userId: string): ConfidenceSettings {
  const path = confidenceSettingsPath(userId);
  if (!existsSync(path)) return { ...DEFAULT_CONFIDENCE_SETTINGS };
  return { ...DEFAULT_CONFIDENCE_SETTINGS, ...JSON.parse(readFileSync(path, "utf8")) };
}

function saveConfidenceSettings(userId: string, settings: ConfidenceSettings): void {
  const path = confidenceSettingsPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2), "utf8");
}

export class InvalidConfidenceThresholdError extends Error {
  constructor(threshold: number) {
    super(`Confidence threshold must be a number between 0 and 100 -- got ${threshold}.`);
    this.name = "InvalidConfidenceThresholdError";
  }
}

export function setConfidenceThreshold(userId: string, threshold: number): ConfidenceSettings {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    throw new InvalidConfidenceThresholdError(threshold);
  }
  const settings = getConfidenceSettings(userId);
  settings.threshold = threshold;
  saveConfidenceSettings(userId, settings);
  return settings;
}

export function setAutoApproveBelowThreshold(userId: string, enabled: boolean): ConfidenceSettings {
  const settings = getConfidenceSettings(userId);
  settings.autoApproveBelowThreshold = enabled;
  saveConfidenceSettings(userId, settings);
  return settings;
}

export interface PendingTradeApproval {
  id: string;
  order: OrderRequest;
  confidence: number;
  reason?: string;
  createdAt: number;
}

function pendingTradePath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "pending-trade-approvals.json");
}

function readPendingTrades(userId: string): PendingTradeApproval[] {
  const path = pendingTradePath(userId);
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8"));
}

function savePendingTrades(userId: string, pending: PendingTradeApproval[]): void {
  const path = pendingTradePath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(pending, null, 2), "utf8");
}

export type ConfidenceGateDecision = { needsApproval: false } | { needsApproval: true; pendingId: string; threshold: number };

/** The real gate: below threshold and auto-approval is off -> queued, not fired. */
export function evaluateConfidenceGate(userId: string, order: OrderRequest, confidence: number, reason?: string): ConfidenceGateDecision {
  const settings = getConfidenceSettings(userId);
  if (confidence >= settings.threshold || settings.autoApproveBelowThreshold) {
    return { needsApproval: false };
  }
  const pending = readPendingTrades(userId);
  const entry: PendingTradeApproval = { id: `${Date.now()}-${pending.length}`, order, confidence, reason, createdAt: Date.now() };
  pending.push(entry);
  savePendingTrades(userId, pending);
  return { needsApproval: true, pendingId: entry.id, threshold: settings.threshold };
}

export function listPendingTradeApprovals(userId: string): PendingTradeApproval[] {
  return readPendingTrades(userId);
}

export class TradeApprovalNotFoundError extends Error {
  constructor(id: string) {
    super(`No pending trade approval ${id}.`);
    this.name = "TradeApprovalNotFoundError";
  }
}

/** Removes and returns the pending entry -- used by both approve (caller then places the real
 *  order) and decline (caller just discards it) so there is exactly one real source of truth for
 *  "is this still pending", never two copies that could drift. */
export function takePendingTradeApproval(userId: string, id: string): PendingTradeApproval {
  const pending = readPendingTrades(userId);
  const entry = pending.find((p) => p.id === id);
  if (!entry) throw new TradeApprovalNotFoundError(id);
  savePendingTrades(userId, pending.filter((p) => p.id !== id));
  return entry;
}

export function resetConfidenceSettingsForUser(userId: string): void {
  rmSync(confidenceSettingsPath(userId), { force: true });
  rmSync(pendingTradePath(userId), { force: true });
}
