import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendSettingsLogEntry } from "./settings-log.js";

/**
 * Real feature (the trader: "all the self aware alerts give an off and on switch in the settings").
 *
 * The Self-Aware Trade Monitor's warnings serve BOTH sides -- they push to the user AND they show
 * up in Dave's own per-turn context so the bot can act on them (move a stop to breakeven, close a
 * stuck trade, hold its risk after a win streak). Some traders don't want every one of them, so each
 * category has a real, per-user on/off switch, persisted and read fresh, in the same file-backed
 * shape as every other setting here. Default: every alert ON.
 *
 * Switching one OFF silences it for BOTH the user push and Dave's context surfacing -- so turning
 * off e.g. "stuck trade" genuinely means neither the user nor the bot is nagged about it.
 */

export type AlertCategory =
  | "loss_duration" // the 5m / 10m "still in the red" nudges
  | "deep_loss" //     halfway-to-stop / deep-loss danger
  | "recovery" //      climbed back to profit after a prolonged loss
  | "breakeven" //     up ~1R -- move the stop to breakeven
  | "stuck" //         flat near breakeven for 15+ min, tying up capital
  | "hot_hand" //      3+ wins in a row -- don't oversize / loosen rules
  // The trader's five profit-side checks. Each gets its own switch for the same reason the others
  // do: these fire per-trade on a 30s sweep, so whichever one turns out to be noisy in practice
  // must be silenceable on its own rather than forcing the whole feature off.
  | "profit_stable" //     in profit ~5 min -- is the original plan still valid
  | "profit_drop" //       profitable ~10 min and now giving it back
  | "peak_pullback" //     pulled back meaningfully from the tracked peak
  | "range" //             sustained chop -- the expected move never developed
  | "quick_profit_check"; // in profit ~10 min -- still heading for the original target

export const ALERT_CATEGORIES: { id: AlertCategory; label: string }[] = [
  { id: "loss_duration", label: "Loss-duration nudges (5m / 10m in the red)" },
  { id: "deep_loss", label: "Deep-loss danger (approaching the stop)" },
  { id: "recovery", label: "Recovery (back to profit after a loss)" },
  { id: "breakeven", label: "Breakeven guard (up ~1R — move stop to BE)" },
  { id: "stuck", label: "Stuck trade (flat near breakeven 15+ min)" },
  { id: "hot_hand", label: "Hot-hand warning (3+ wins in a row)" },
  { id: "profit_stable", label: "Profit stability (in profit 5 min — plan still valid?)" },
  { id: "profit_drop", label: "Profit reduction (profit starting to fall back)" },
  { id: "peak_pullback", label: "Peak pullback (gave back part of the peak)" },
  { id: "range", label: "Range detected (chop — expected move never came)" },
  { id: "quick_profit_check", label: "Quick profit check (10 min — still on target?)" },
];

const VALID = new Set<AlertCategory>(ALERT_CATEGORIES.map((c) => c.id));

export type AlertToggles = Record<AlertCategory, boolean>;

function defaultToggles(): AlertToggles {
  return {
    loss_duration: true,
    deep_loss: true,
    recovery: true,
    breakeven: true,
    stuck: true,
    hot_hand: true,
    profit_stable: true,
    profit_drop: true,
    peak_pullback: true,
    range: true,
    quick_profit_check: true,
  };
}

export class InvalidAlertCategoryError extends Error {
  constructor(category: string) {
    super(`Unknown self-aware alert "${category}". Valid ones: ${ALERT_CATEGORIES.map((c) => c.id).join(", ")}.`);
    this.name = "InvalidAlertCategoryError";
  }
}

function togglesPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "self-aware-alerts.json");
}

/** All switches, defaulting any missing/corrupt entry to ON (never silently swallow an alert). */
export function getAlertToggles(userId: string): AlertToggles {
  const base = defaultToggles();
  const path = togglesPath(userId);
  if (!existsSync(path)) return base;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Record<AlertCategory, unknown>>;
    for (const c of VALID) {
      if (typeof parsed[c] === "boolean") base[c] = parsed[c] as boolean;
    }
    return base;
  } catch {
    return base;
  }
}

export function isAlertEnabled(userId: string, category: AlertCategory): boolean {
  return getAlertToggles(userId)[category] !== false;
}

export function setAlertToggle(userId: string, category: AlertCategory, on: boolean): AlertToggles {
  if (!VALID.has(category)) throw new InvalidAlertCategoryError(category);
  const current = getAlertToggles(userId);
  const previous = current[category];
  const next: AlertToggles = { ...current, [category]: on };
  const path = togglesPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2), "utf8");
  appendSettingsLogEntry(userId, `selfAwareAlert:${category}`, previous ? "on" : "off", on ? "on" : "off");
  return next;
}
