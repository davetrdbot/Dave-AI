import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ALERT_CATEGORIES,
  MAX_SETTABLE_RISK_REWARD,
  MIN_SETTABLE_RISK_REWARD,
  approveProtectedLimitChange,
  getActiveGroupInfo,
  getAlertToggles,
  getAutoApprovalEnabled,
  getConfidenceSettings,
  getDeepLossAlertPercent,
  getMinRiskReward,
  getRiskSettings,
  getSelfPauseEnabled,
  getSequentialThinkingEnabled,
  getTradingSession,
  getTwoStepTradingEnabled,
  listGroups,
  proposeProtectedLimitChange,
  setActiveGroup,
  setAlertToggle,
  setAutoApprovalEnabled,
  setAutoApproveBelowThreshold,
  setConfidenceThreshold,
  setDeepLossAlertPercent,
  setMinRiskReward,
  setRiskMode,
  setSelfPauseEnabled,
  setSequentialThinkingEnabled,
  setTradingSession,
  setTwoStepTradingEnabled,
  type AlertCategory,
  type TradingSession,
} from "@dave/trading";
import { getWriteApprovalSetting, setWriteApprovalSetting } from "@dave/memory";

/**
 * Every trader-changeable bot setting, in one place, for the app.
 *
 * Each one goes through the SAME setter the Telegram /settings screens use, so a change made in
 * the app is indistinguishable from one made in chat: same validation, same file, same settings
 * log. Nothing here stores a value of its own.
 *
 * The one exception is the AI response timeout, which lives in `@dave/agent-loop` -- a package
 * this process cannot import (see bot-control.ts). Its file format is mirrored here exactly, the
 * same way bot-control.ts mirrors the trading flags.
 */

export class InvalidSettingError extends Error {}

const SESSIONS: TradingSession[] = ["all", "sydney", "asian", "london", "new_york"];
const RISK_MODES = ["off", "on", "auto"] as const;

const TIMEOUT_MIN = 3;
const TIMEOUT_MAX = 120;

function timeoutPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "provider-timeout", userId, "config.json");
}

function readTimeouts(userId: string): { primarySeconds: number; fallbackSeconds: number } {
  const path = timeoutPath(userId);
  const fallback = { primarySeconds: 20, fallbackSeconds: 5 };
  if (!existsSync(path)) return fallback;
  try {
    return { ...fallback, ...(JSON.parse(readFileSync(path, "utf8")) as object) };
  } catch {
    return fallback;
  }
}

function writeTimeouts(userId: string, config: { primarySeconds: number; fallbackSeconds: number }): void {
  const path = timeoutPath(userId);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2), "utf8");
}

export function readAppSettings(userId: string) {
  const risk = getRiskSettings(userId);
  const confidence = getConfidenceSettings(userId);
  const toggles = getAlertToggles(userId);
  const groups = listGroups(userId);
  const active = getActiveGroupInfo(userId);
  const timeouts = readTimeouts(userId);
  return {
    trading: {
      riskReward: { value: getMinRiskReward(userId), min: MIN_SETTABLE_RISK_REWARD, max: MAX_SETTABLE_RISK_REWARD },
      confidenceThreshold: { value: confidence.threshold, min: 0, max: 100 },
      autoApproveBelowThreshold: confidence.autoApproveBelowThreshold,
      stopLoss: { mode: risk.slMode, value: risk.slValue ?? null, unit: "pips" },
      takeProfit: { mode: risk.tpMode, value: risk.tpValue ?? null, unit: "pips" },
      lotSize: { mode: risk.lotMode, value: risk.lotValue ?? null, unit: "lots" },
      maxOpenTrades: risk.maxOpenTrades ?? null,
      maxDailyLossPct: risk.maxDailyLossPct ?? null,
      session: { value: getTradingSession(userId), options: SESSIONS },
      pairGroup: {
        value: active.activeGroup?.id ?? null,
        options: groups.map((g) => ({ id: g.id, name: g.name, symbols: g.symbols.length })),
      },
    },
    behaviour: {
      autoApproval: getAutoApprovalEnabled(userId),
      selfPause: getSelfPauseEnabled(userId),
      twoStepTrading: getTwoStepTradingEnabled(userId),
      sequentialThinking: getSequentialThinkingEnabled(userId),
      memoryWriteApproval: getWriteApprovalSetting(userId),
    },
    alerts: {
      deepLossPercent: { value: getDeepLossAlertPercent(userId), min: 5, max: 95 },
      toggles: ALERT_CATEGORIES.map((c) => ({ id: c.id, label: c.label, on: toggles[c.id] })),
    },
    ai: {
      primaryTimeoutSeconds: { value: timeouts.primarySeconds, min: TIMEOUT_MIN, max: TIMEOUT_MAX },
      fallbackTimeoutSeconds: { value: timeouts.fallbackSeconds, min: TIMEOUT_MIN, max: TIMEOUT_MAX },
    },
  };
}

function num(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new InvalidSettingError(`${what} must be a number.`);
  return v;
}

function bool(v: unknown, what: string): boolean {
  if (typeof v !== "boolean") throw new InvalidSettingError(`${what} must be on or off.`);
  return v;
}

function int(v: unknown, what: string, min: number, max: number): number {
  const n = num(v, what);
  if (!Number.isInteger(n) || n < min || n > max) throw new InvalidSettingError(`${what} must be a whole number from ${min} to ${max}.`);
  return n;
}

/**
 * Applies one change. `id` names the setting; `value` is its new value.
 *
 * Max open trades and max daily loss are "protected" -- Dave may only PROPOSE a change to them and
 * the trader approves. Here the trader is the one making the change, so the proposal is approved
 * in the same step, leaving the same audit trail an approved proposal would.
 */
export function applyAppSetting(userId: string, id: string, value: unknown): void {
  if (id.startsWith("alert:")) {
    setAlertToggle(userId, id.slice("alert:".length) as AlertCategory, bool(value, "An alert"));
    return;
  }
  switch (id) {
    case "riskReward":
      setMinRiskReward(userId, num(value, "Risk:reward"));
      return;
    case "confidenceThreshold":
      setConfidenceThreshold(userId, int(value, "Confidence", 0, 100));
      return;
    case "autoApproveBelowThreshold":
      setAutoApproveBelowThreshold(userId, bool(value, "Auto-approve"));
      return;
    case "stopLoss":
    case "takeProfit":
    case "lotSize": {
      const v = (value ?? {}) as { mode?: unknown; value?: unknown };
      if (!RISK_MODES.includes(v.mode as (typeof RISK_MODES)[number])) throw new InvalidSettingError("Mode must be off, on or auto.");
      const mode = v.mode as (typeof RISK_MODES)[number];
      let amount: number | undefined;
      if (mode === "on") {
        amount = num(v.value, "The value");
        if (amount <= 0) throw new InvalidSettingError("The value must be more than zero.");
      }
      setRiskMode(userId, id === "stopLoss" ? "sl" : id === "takeProfit" ? "tp" : "lot", mode, amount);
      return;
    }
    case "maxOpenTrades":
    case "maxDailyLossPct": {
      const n = id === "maxOpenTrades" ? int(value, "Max open trades", 1, 50) : num(value, "Max daily loss");
      if (id === "maxDailyLossPct" && (n <= 0 || n > 100)) throw new InvalidSettingError("Max daily loss must be between 0 and 100%.");
      const change = proposeProtectedLimitChange(userId, id, n, "Changed by the trader in the phone app");
      approveProtectedLimitChange(userId, change.id);
      return;
    }
    case "session":
      if (!SESSIONS.includes(value as TradingSession)) throw new InvalidSettingError("Unknown trading session.");
      setTradingSession(userId, value as TradingSession);
      return;
    case "pairGroup":
      if (typeof value !== "string") throw new InvalidSettingError("Pick a pair group.");
      setActiveGroup(userId, value);
      return;
    case "autoApproval":
      setAutoApprovalEnabled(userId, bool(value, "Auto-approval"));
      return;
    case "selfPause":
      setSelfPauseEnabled(userId, bool(value, "Self-pause"));
      return;
    case "twoStepTrading":
      setTwoStepTradingEnabled(userId, bool(value, "Two-step trading"));
      return;
    case "sequentialThinking":
      setSequentialThinkingEnabled(userId, bool(value, "Sequential thinking"));
      return;
    case "memoryWriteApproval":
      setWriteApprovalSetting(userId, bool(value, "Memory approval"));
      return;
    case "deepLossPercent":
      setDeepLossAlertPercent(userId, num(value, "Deep-loss alert"));
      return;
    case "primaryTimeoutSeconds":
    case "fallbackTimeoutSeconds": {
      const seconds = int(value, "The timeout", TIMEOUT_MIN, TIMEOUT_MAX);
      const current = readTimeouts(userId);
      writeTimeouts(userId, id === "primaryTimeoutSeconds" ? { ...current, primarySeconds: seconds } : { ...current, fallbackSeconds: seconds });
      return;
    }
    default:
      throw new InvalidSettingError(`Unknown setting "${id}".`);
  }
}
