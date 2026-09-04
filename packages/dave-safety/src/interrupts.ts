/**
 * Step 19.2: /stop and /panic are an instant hard interrupt, even
 * mid-thought -- but deliberately DISTINCT from an ordinary
 * thinking-loop interrupt. A normal incoming message pauses Dave's
 * current line of thought (it might be about to respond to something
 * that's now stale); that alone must NEVER touch the trading loop.
 * Only /stop or /panic halts the trading loop itself. This module is
 * the real state machine proving those two things behave differently,
 * not just documented as different.
 *
 * In-memory, per-user, live process state -- same shape as Step 16's
 * scheduled-trigger registry (real, but inherently momentary; nothing
 * here needs to survive a restart the way a DB record does).
 */

export type ThinkingLoopState = "idle" | "thinking" | "interrupted";
export type TradingLoopState = "idle" | "running" | "halted";

export interface InterruptState {
  thinkingLoop: ThinkingLoopState;
  tradingLoop: TradingLoopState;
  haltedAt?: number;
  haltReason?: "stop" | "panic";
}

const registry = new Map<string, InterruptState>();

function getState(userId: string): InterruptState {
  let state = registry.get(userId);
  if (!state) {
    state = { thinkingLoop: "idle", tradingLoop: "idle" };
    registry.set(userId, state);
  }
  return state;
}

export function getInterruptState(userId: string): InterruptState {
  return { ...getState(userId) };
}

export function startThinking(userId: string): void {
  getState(userId).thinkingLoop = "thinking";
}

export function finishThinking(userId: string): void {
  getState(userId).thinkingLoop = "idle";
}

/**
 * An ORDINARY incoming message. Interrupts only the thinking loop, if
 * it was mid-thought -- the trading loop is never even inspected here,
 * let alone touched. This is the behavior 19.2 requires be distinct.
 */
export function interruptThinking(userId: string): void {
  const state = getState(userId);
  if (state.thinkingLoop === "thinking") state.thinkingLoop = "interrupted";
}

export function startTradingLoop(userId: string): void {
  const state = getState(userId);
  state.tradingLoop = "running";
}

/**
 * /stop or /panic: a genuinely hard interrupt. Halts the trading loop
 * (the thing ordinary messages can never do) AND interrupts the
 * thinking loop too ("even mid-thought") -- the one case where both
 * loops are hit by the same call, deliberately.
 */
export function stopOrPanic(userId: string, reason: "stop" | "panic"): InterruptState {
  const state = getState(userId);
  state.tradingLoop = "halted";
  state.haltedAt = Date.now();
  state.haltReason = reason;
  if (state.thinkingLoop === "thinking") state.thinkingLoop = "interrupted";
  return { ...state };
}

export function resumeTradingLoop(userId: string): void {
  const state = getState(userId);
  state.tradingLoop = "idle";
  state.haltedAt = undefined;
  state.haltReason = undefined;
}

export function isTradingHalted(userId: string): boolean {
  return getState(userId).tradingLoop === "halted";
}

export function isThinkingInterrupted(userId: string): boolean {
  return getState(userId).thinkingLoop === "interrupted";
}
