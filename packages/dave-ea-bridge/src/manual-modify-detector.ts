import type { EaPosition } from "./ea-webhook.js";

/**
 * Update 11 (manual trade change detection, part 2): "detect and be
 * notified when the user manually MODIFIES an open trade's SL or TP
 * directly in the terminal, without going through Dave." Same real
 * comparison idea as `detectManualCloses` -- two consecutive real EA
 * reports for the SAME ticket, any SL/TP difference is a genuine
 * change the EA observed, Dave didn't have to be told.
 */
export interface ManualModification {
  ticket: string;
  symbol: string;
  field: "sl" | "tp";
  oldValue: number | undefined;
  newValue: number | undefined;
}

export function detectManualModifications(previousPositions: EaPosition[], newPositions: EaPosition[]): ManualModification[] {
  const prevByTicket = new Map(previousPositions.map((p) => [p.ticket, p]));
  const modifications: ManualModification[] = [];

  for (const pos of newPositions) {
    const prev = prevByTicket.get(pos.ticket);
    if (!prev) continue; // a brand-new position, not a modification of an existing one
    if (prev.sl !== pos.sl) {
      modifications.push({ ticket: pos.ticket, symbol: pos.symbol, field: "sl", oldValue: prev.sl, newValue: pos.sl });
    }
    if (prev.tp !== pos.tp) {
      modifications.push({ ticket: pos.ticket, symbol: pos.symbol, field: "tp", oldValue: prev.tp, newValue: pos.tp });
    }
  }
  return modifications;
}
