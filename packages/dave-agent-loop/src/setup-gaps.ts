import type { DaveDatabase } from "@dave/db";
import { getModelConfig, listProviderKeys, type ProviderName } from "@dave/brain";
import { getEaConnectionStatus, getLastKnownAccountSnapshot } from "@dave/ea-bridge";

/**
 * What a fresh install still needs before Dave can trade, in the words the trader should read.
 * Used at the end of onboarding and when every AI provider fails for lack of keys -- the two
 * moments a new user otherwise gets either a false "I'm already scanning" or a bare error.
 */
export function setupGaps(db: DaveDatabase, userId: string): string[] {
  const gaps: string[] = [];
  if (!hasAnyAiKey(db, userId)) {
    gaps.push("Add an AI key -- in the web panel's AI providers card, or in the Dave app under Settings → AI providers. I can't think without one.");
  }
  if (getEaConnectionStatus(userId).connected && getLastKnownAccountSnapshot(userId)?.algoTrading === false) {
    gaps.push("Turn on Algo Trading in MetaTrader 5 -- the EA is connected, but MT5 refuses its orders while that button is off. (In my container, /mt5 -> Restart MT5 turns it back on.)");
  }
  if (!getEaConnectionStatus(userId).connected) {
    gaps.push("Connect MetaTrader 5 -- /mt5 runs it in my own container with no VPS (you send your login), or /ea gives you the EA file for an MT5 you run yourself.");
  }
  return gaps;
}

/** True when the main AI or any backup has at least one stored key. */
export function hasAnyAiKey(db: DaveDatabase, userId: string): boolean {
  try {
    const config = getModelConfig(userId);
    return [config.primary, ...config.fallback].some((p) => listProviderKeys(db, userId, p as ProviderName).length > 0);
  } catch {
    return false;
  }
}
