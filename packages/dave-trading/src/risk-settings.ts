import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Step 10.1: SL, TP, and lot size each have an Off/On/Auto mode. "On"
 * always means the user's own exact value -- never a hardcoded default.
 * Max open trades and max daily loss are optional, off by default, and
 * PROTECTED per SECURITY.md: changing them always requires fresh
 * explicit approval, never bundled into a general settings change.
 */

export type RiskMode = "off" | "on" | "auto";

export interface RiskSettings {
  slMode: RiskMode;
  slValue?: number; // only meaningful when slMode === "on"
  tpMode: RiskMode;
  tpValue?: number;
  lotMode: RiskMode;
  lotValue?: number;
  maxOpenTrades?: number; // protected -- see requestProtectedLimitChange
  maxDailyLossPct?: number; // protected
}

const DEFAULT_SETTINGS: RiskSettings = { slMode: "off", tpMode: "off", lotMode: "off" };

function settingsPath(userId: string): string {
  return join(process.cwd(), "data", "trading", userId, "risk-settings.json");
}

export function getRiskSettings(userId: string): RiskSettings {
  const path = settingsPath(userId);
  if (!existsSync(path)) return { ...DEFAULT_SETTINGS };
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveRiskSettings(userId: string, settings: RiskSettings): void {
  const path = settingsPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2), "utf8");
}

export class OnModeRequiresValueError extends Error {
  constructor(field: "sl" | "tp" | "lot") {
    super(`Setting ${field} to "on" requires the user's own exact value -- prompt for it, never assume a default.`);
    this.name = "OnModeRequiresValueError";
  }
}

/**
 * Sets SL/TP/lot mode. Enforced here, not just documented: passing
 * mode="on" without a real value throws -- this is what makes "On always
 * prompts for the user's own exact value" a real constraint instead of a
 * convention callers could forget.
 */
export function setRiskMode(userId: string, field: "sl" | "tp" | "lot", mode: RiskMode, value?: number): void {
  if (mode === "on" && (value === undefined || value === null)) {
    throw new OnModeRequiresValueError(field);
  }
  const settings = getRiskSettings(userId);
  if (field === "sl") {
    settings.slMode = mode;
    settings.slValue = mode === "on" ? value : undefined;
  } else if (field === "tp") {
    settings.tpMode = mode;
    settings.tpValue = mode === "on" ? value : undefined;
  } else {
    settings.lotMode = mode;
    settings.lotValue = mode === "on" ? value : undefined;
  }
  saveRiskSettings(userId, settings);
}

// --- Protected limits: max open trades, max daily loss ---

interface PendingLimitChange {
  id: string;
  field: "maxOpenTrades" | "maxDailyLossPct";
  newValue: number;
  reason: string;
  createdAt: number;
}

function pendingLimitPath(userId: string): string {
  return join(process.cwd(), "data", "trading", userId, "pending-limit-changes.json");
}

function readPendingLimits(userId: string): PendingLimitChange[] {
  const path = pendingLimitPath(userId);
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8"));
}

function savePendingLimits(userId: string, changes: PendingLimitChange[]): void {
  const path = pendingLimitPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(changes, null, 2), "utf8");
}

/**
 * Step 10.1/SECURITY.md: proposing a change to a protected limit never
 * applies it directly -- it's queued, requiring a SEPARATE, fresh
 * approveProtectedLimitChange() call. Never bundled into
 * setRiskMode()/general settings, and a prior approval never carries
 * over to a new proposed value.
 */
export function proposeProtectedLimitChange(userId: string, field: "maxOpenTrades" | "maxDailyLossPct", newValue: number, reason: string): PendingLimitChange {
  const changes = readPendingLimits(userId);
  const change: PendingLimitChange = { id: `${Date.now()}-${changes.length}`, field, newValue, reason, createdAt: Date.now() };
  changes.push(change);
  savePendingLimits(userId, changes);
  return change;
}

export function listPendingLimitChanges(userId: string): PendingLimitChange[] {
  return readPendingLimits(userId);
}

/** Explicit, separate approval -- this is the only way a protected limit ever actually changes. */
export function approveProtectedLimitChange(userId: string, changeId: string): RiskSettings {
  const changes = readPendingLimits(userId);
  const change = changes.find((c) => c.id === changeId);
  if (!change) throw new Error(`No pending limit change ${changeId} for ${userId}`);
  const settings = getRiskSettings(userId);
  settings[change.field] = change.newValue;
  saveRiskSettings(userId, settings);
  savePendingLimits(userId, changes.filter((c) => c.id !== changeId));
  return settings;
}

export function rejectProtectedLimitChange(userId: string, changeId: string): void {
  const changes = readPendingLimits(userId);
  savePendingLimits(userId, changes.filter((c) => c.id !== changeId));
}
