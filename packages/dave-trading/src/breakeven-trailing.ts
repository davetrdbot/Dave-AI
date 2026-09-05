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
 *
 * Corrected per explicit feedback: this is NOT automatic behavior every
 * trade gets by default. It's a capability Dave can choose to turn on
 * for a specific position if it decides the setup calls for it --
 * `breakevenTrailingEnabled` defaults to false, and a normal trade
 * placed without Dave explicitly opting a position in gets none of this.
 * `processPriceTick` is a real no-op (slChanged: false, position
 * unchanged) on a position that hasn't opted in, checked first before
 * any TP-stage logic runs.
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
  /** Off by default. Only Dave choosing to enable this per-position turns the mechanism on at all. */
  breakevenTrailingEnabled: boolean;
}

/** Creates a position with breakeven/trailing OFF -- the normal, default shape for a newly placed trade. */
export function newPosition(fields: Omit<Position, "tp1Hit" | "tp2Hit" | "tp3Hit" | "breakevenTrailingEnabled">): Position {
  return { ...fields, tp1Hit: false, tp2Hit: false, tp3Hit: false, breakevenTrailingEnabled: false };
}

/**
 * Dave's own explicit, per-position opt-in -- "if it wishes," not
 * automatic. Real condition enforced here (previously missing): this
 * only ever applies to a position genuinely set up with all three TP
 * levels. A normal single-TP trade must get zero automatic SL movement
 * from this mechanism -- so a position missing tp1, tp2, or tp3 is
 * rejected outright rather than silently enabled with partial stages.
 */
export function enableBreakevenTrailing(position: Position): Position {
  if (position.tp1 === undefined || position.tp2 === undefined || position.tp3 === undefined) {
    throw new Error(
      "breakeven/trailing requires a position explicitly set up with TP1, TP2, AND TP3 -- this position is missing at least one, so it stays a normal single-TP trade with no automatic SL movement."
    );
  }
  return { ...position, breakevenTrailingEnabled: true };
}

export function disableBreakevenTrailing(position: Position): Position {
  return { ...position, breakevenTrailingEnabled: false };
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
  if (!position.breakevenTrailingEnabled) {
    // Real no-op: a position that hasn't opted in gets no SL movement
    // from this mechanism at all, regardless of price.
    return { position, slChanged: false };
  }

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
