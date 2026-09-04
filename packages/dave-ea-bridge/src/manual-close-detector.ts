import type { EaPosition } from "./ea-webhook.js";

/**
 * Step 11.1: "Detects manual closes" -- a position the user closed by
 * hand in the MT5 terminal itself, not through Dave. Pure comparison:
 * any ticket present in the previous report but missing from the new
 * one is a real disappearance the EA observed -- Dave didn't have to be
 * told, it can tell from two consecutive real snapshots.
 */
export function detectManualCloses(previousPositions: EaPosition[], newPositions: EaPosition[]): EaPosition[] {
  const stillOpen = new Set(newPositions.map((p) => p.ticket));
  return previousPositions.filter((p) => !stillOpen.has(p.ticket));
}
