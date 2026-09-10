import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Item 12 real gap fixed (user: "lot size settings currently only offer Auto/Off... add the
 * missing 'On' state where the user can type in their own exact lot size (matching the same
 * On/Off/Auto pattern used for SL/TP)"). Direct investigation found the identical gap already
 * existed for SL/TP too: command-router.ts's cyclemode button deliberately only toggles
 * off<->auto (its own comment: "'on' mode requires the user's own exact numeric value... a
 * button tap can't supply") -- but no text-capture flow existed to let the user actually TYPE
 * that value, for any of sl/tp/lot. Only the protected limits (maxOpenTrades/maxDailyLossPct)
 * had a real tap-to-type flow (pending-limit-entry.ts). This is the same next-message-IS-the-
 * value capture pattern, for the "On" tap target now added to all three risk fields.
 */
export type RiskEntryField = "sl" | "tp" | "lot";

function pendingPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "pending-risk-entry.json");
}

export function setPendingRiskEntry(userId: string, field: RiskEntryField | null): void {
  const path = pendingPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(field), "utf8");
}

export function getPendingRiskEntry(userId: string): RiskEntryField | null {
  const path = pendingPath(userId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}
