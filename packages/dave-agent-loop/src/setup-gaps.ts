import type { DaveDatabase } from "@dave/db";
import { getModelConfig, listProviderKeys, type ProviderName } from "@dave/brain";
import { getEaConnectionStatus } from "@dave/ea-bridge";

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
  if (!getEaConnectionStatus(userId).connected) {
    gaps.push("Connect MetaTrader 5 -- send /ea and I'll give you the EA file, set up with your server's address.");
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
