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
// --- Update 8: generalized to any Dave-INITIATED settings change (SL/
//     TP/lot mode included), gated by approve/decline by default, with
//     an opt-in auto-approval switch. Protected limits stay extra-
//     protected: they ALWAYS require explicit approval regardless of
//     the auto-approval switch, per the existing SECURITY.md posture.

export type PendingSettingsChange =
  | { id: string; field: "sl" | "tp" | "lot"; mode: RiskMode; value?: number; reason: string; createdAt: number }
  | { id: string; field: "maxOpenTrades" | "maxDailyLossPct"; newValue: number; reason: string; createdAt: number };

const PROTECTED_FIELDS = new Set<PendingSettingsChange["field"]>(["maxOpenTrades", "maxDailyLossPct"]);

function pendingLimitPath(userId: string): string {
  return join(process.cwd(), "data", "trading", userId, "pending-settings-changes.json");
}

function readPendingLimits(userId: string): PendingSettingsChange[] {
  const path = pendingLimitPath(userId);
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8"));
}

function savePendingLimits(userId: string, changes: PendingSettingsChange[]): void {
  const path = pendingLimitPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(changes, null, 2), "utf8");
}

function isModeField(change: PendingSettingsChange): change is Extract<PendingSettingsChange, { mode: RiskMode }> {
  return change.field === "sl" || change.field === "tp" || change.field === "lot";
}

function applyPendingChange(userId: string, change: PendingSettingsChange): RiskSettings {
  const settings = getRiskSettings(userId);
  if (isModeField(change)) {
    if (change.field === "sl") {
      settings.slMode = change.mode;
      settings.slValue = change.mode === "on" ? change.value : undefined;
    } else if (change.field === "tp") {
      settings.tpMode = change.mode;
      settings.tpValue = change.mode === "on" ? change.value : undefined;
    } else {
      settings.lotMode = change.mode;
      settings.lotValue = change.mode === "on" ? change.value : undefined;
    }
  } else {
    settings[change.field] = change.newValue;
  }
  saveRiskSettings(userId, settings);
  return settings;
}

/**
 * Step 10.1/SECURITY.md: proposing a change to a protected limit never
 * applies it directly -- it's queued, requiring a SEPARATE, fresh
 * approveProtectedLimitChange() call. Never bundled into
 * setRiskMode()/general settings, and a prior approval never carries
 * over to a new proposed value.
 */
export function proposeProtectedLimitChange(userId: string, field: "maxOpenTrades" | "maxDailyLossPct", newValue: number, reason: string): PendingSettingsChange {
  const changes = readPendingLimits(userId);
  const change: PendingSettingsChange = { id: `${Date.now()}-${changes.length}`, field, newValue, reason, createdAt: Date.now() };
  changes.push(change);
  savePendingLimits(userId, changes);
  return change;
}

export function listPendingLimitChanges(userId: string): PendingSettingsChange[] {
  return readPendingLimits(userId);
}

/** Explicit, separate approval -- this is the only way a protected limit ever actually changes. */
export function approveProtectedLimitChange(userId: string, changeId: string): RiskSettings {
  const changes = readPendingLimits(userId);
  const change = changes.find((c) => c.id === changeId);
  if (!change) throw new Error(`No pending limit change ${changeId} for ${userId}`);
  const settings = applyPendingChange(userId, change);
  savePendingLimits(userId, changes.filter((c) => c.id !== changeId));
  return settings;
}

export function rejectProtectedLimitChange(userId: string, changeId: string): void {
  const changes = readPendingLimits(userId);
  savePendingLimits(userId, changes.filter((c) => c.id !== changeId));
}

// --- Auto-approval switch: OFF by default -- Dave must ask before it acts on its own initiative ---

function autoApprovalPath(userId: string): string {
  return join(process.cwd(), "data", "trading", userId, "auto-approval.json");
}

export function getAutoApprovalEnabled(userId: string): boolean {
  const path = autoApprovalPath(userId);
  if (!existsSync(path)) return false;
  return (JSON.parse(readFileSync(path, "utf8")) as { enabled: boolean }).enabled;
}

export function setAutoApprovalEnabled(userId: string, enabled: boolean): void {
  const path = autoApprovalPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify({ enabled }, null, 2), "utf8");
}

export interface SettingsChangeDecision {
  applied: boolean;
  pendingId?: string;
  settings?: RiskSettings;
}

/**
 * Update 8: the entry point for a Dave-INITIATED settings change --
 * "whenever it wants to do it, it should ask the user approve or
 * decline ... unless auto-approval is on." SL/TP/lot respect the
 * auto-approval switch; maxOpenTrades/maxDailyLossPct never do
 * (PROTECTED_FIELDS), matching the existing extra-protection posture.
 * A user calling setRiskMode()/proposeProtectedLimitChange() directly
 * (their OWN action via a settings command) is unaffected -- this
 * function is specifically for Dave proposing a change on its own.
 */
export function proposeSettingsChange(userId: string, field: "sl" | "tp" | "lot", mode: RiskMode, value: number | undefined, reason: string): SettingsChangeDecision {
  if (mode === "on" && (value === undefined || value === null)) {
    throw new OnModeRequiresValueError(field);
  }
  const change: PendingSettingsChange = { id: `${Date.now()}-${readPendingLimits(userId).length}`, field, mode, value, reason, createdAt: Date.now() };

  if (!PROTECTED_FIELDS.has(field) && getAutoApprovalEnabled(userId)) {
    const settings = applyPendingChange(userId, change);
    return { applied: true, settings };
  }

  const changes = readPendingLimits(userId);
  changes.push(change);
  savePendingLimits(userId, changes);
  return { applied: false, pendingId: change.id };
}

/** Generalized approve, covering SL/TP/lot as well as protected limits. */
export function approveSettingsChange(userId: string, changeId: string): RiskSettings {
  return approveProtectedLimitChange(userId, changeId);
}

export function declineSettingsChange(userId: string, changeId: string): void {
  rejectProtectedLimitChange(userId, changeId);
}
