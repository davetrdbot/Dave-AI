/**
 * Step 10.9: breakeven and trailing stops. After TP1 is hit, move SL to
 * breakeven. After TP2, trail further. After TP3, lock in more.
 *
 * This module owns the MECHANISM (detecting a TP level was crossed,
 * moving SL accordingly, never moving SL backward) generically -- the
 * actual distances/targets (what "trail further" or "lock in more"
 * concretely means in pips) are supplied by the caller, not invented
 * here, since specific numbers are trading-rule content that only the
 * user's uploaded rules file may define (per the master prompt).
 */

export interface Position {
  id: string;
  direction: "buy" | "sell";
  entry: number;
  sl: number;
  tp1?: number;
  tp2?: number;
  tp3?: number;
  tp1Hit: boolean;
  tp2Hit: boolean;
  tp3Hit: boolean;
}

export interface BreakevenTrailingConfig {
  slAtTp1: number; // typically the entry price (breakeven)
  slAtTp2: number; // typically further locked-in than slAtTp1
  slAtTp3: number; // typically further locked-in than slAtTp2
}

export interface TickResult {
  position: Position;
  slChanged: boolean;
  stage?: "tp1" | "tp2" | "tp3";
}

function reachedLevel(direction: Position["direction"], currentPrice: number, level: number): boolean {
  return direction === "buy" ? currentPrice >= level : currentPrice <= level;
}

/** Never moves SL backward (further from the current locked-in level) -- direction-aware. */
function isForwardMove(direction: Position["direction"], currentSl: number, candidateSl: number): boolean {
  return direction === "buy" ? candidateSl > currentSl : candidateSl < currentSl;
}

/**
 * Processes one price tick against one open position, applying the
 * breakeven/trailing stages in order. Idempotent: calling this
 * repeatedly with prices that already crossed a stage does not re-fire
 * that stage (tracked via tp1Hit/tp2Hit/tp3Hit), and a stage is only
 * ever applied if it actually moves SL forward.
 */
export function processPriceTick(position: Position, currentPrice: number, config: BreakevenTrailingConfig): TickResult {
  let updated = position;
  let slChanged = false;
  let stage: TickResult["stage"];

  if (!updated.tp3Hit && updated.tp3 !== undefined && reachedLevel(updated.direction, currentPrice, updated.tp3)) {
    if (isForwardMove(updated.direction, updated.sl, config.slAtTp3)) {
      updated = { ...updated, sl: config.slAtTp3, tp1Hit: true, tp2Hit: true, tp3Hit: true };
      slChanged = true;
      stage = "tp3";
    } else {
      updated = { ...updated, tp1Hit: true, tp2Hit: true, tp3Hit: true };
    }
  } else if (!updated.tp2Hit && updated.tp2 !== undefined && reachedLevel(updated.direction, currentPrice, updated.tp2)) {
    if (isForwardMove(updated.direction, updated.sl, config.slAtTp2)) {
      updated = { ...updated, sl: config.slAtTp2, tp1Hit: true, tp2Hit: true };
      slChanged = true;
      stage = "tp2";
    } else {
      updated = { ...updated, tp1Hit: true, tp2Hit: true };
    }
  } else if (!updated.tp1Hit && updated.tp1 !== undefined && reachedLevel(updated.direction, currentPrice, updated.tp1)) {
    if (isForwardMove(updated.direction, updated.sl, config.slAtTp1)) {
      updated = { ...updated, sl: config.slAtTp1, tp1Hit: true };
      slChanged = true;
      stage = "tp1";
    } else {
      updated = { ...updated, tp1Hit: true };
    }
  }

  return { position: updated, slChanged, stage };
}
