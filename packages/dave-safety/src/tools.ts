import type { DaveDatabase } from "@dave/db";
import { getReport, resetCircuitBreaker, isTripped } from "./circuit-breaker.js";
import { getInterruptState, stopOrPanic, resumeTradingLoop, isTradingHalted } from "./interrupts.js";
import { detectManualCloses, type EaPosition } from "@dave/ea-bridge";
import { detectManualModifications } from "@dave/ea-bridge";

/**
 * Update 18 (bulk tool-coverage expansion): dave-safety's real
 * circuit-breaker/interrupt state machines (Step 19) had no agent-tool
 * surface. `detect_manual_close`/`detect_manual_modify` expose the SAME
 * real comparison functions the live webhook wiring (Update 15/16)
 * uses, callable on-demand against two position snapshots.
 */
export interface SafetyToolContext {
  userId: string;
  db: DaveDatabase;
}

export interface SafetyToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: SafetyToolContext) => Promise<unknown>;
}

export const SAFETY_TOOLS: SafetyToolDefinition[] = [
  {
    name: "circuit_breaker",
    description: "Get the real circuit-breaker report -- tripped state, consecutive error count, recent errors.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => getReport(ctx.db, ctx.userId),
  },
  {
    name: "check_safety_limits",
    description: "Check whether the circuit breaker is currently tripped (would refuse further action).",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => ({ tripped: isTripped(ctx.db, ctx.userId) }),
  },
  {
    name: "reset_circuit_breaker",
    description: "Reset a tripped circuit breaker -- an explicit, deliberate action, not automatic.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => {
      resetCircuitBreaker(ctx.db, ctx.userId);
      return { ok: true };
    },
  },
  {
    name: "hard_stop",
    description: "Hard interrupt -- halts the TRADING loop immediately (/panic). Distinct from pausing your own thinking.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => stopOrPanic(ctx.userId, "panic"),
  },
  {
    name: "pause_action",
    description: "Halts the trading loop (/stop) -- same real state as hard_stop but framed as a deliberate pause, not an emergency.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => stopOrPanic(ctx.userId, "stop"),
  },
  {
    name: "resume_action",
    description: "Resumes the trading loop after a stop/panic.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => {
      resumeTradingLoop(ctx.userId);
      return { halted: isTradingHalted(ctx.userId) };
    },
  },
  {
    name: "get_interrupt_state",
    description: "Get the real current thinking-loop/trading-loop interrupt state.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => getInterruptState(ctx.userId),
  },
  {
    name: "detect_manual_close",
    description: "Compare two position snapshots and detect any that manually disappeared (the SAME real comparison the live EA webhook uses).",
    parameters: { type: "object", properties: { previousPositions: { type: "array" }, newPositions: { type: "array" } }, required: ["previousPositions", "newPositions"] },
    execute: async (args) => detectManualCloses(args.previousPositions as EaPosition[], args.newPositions as EaPosition[]),
  },
  {
    name: "detect_manual_modify",
    description: "Compare two position snapshots and detect any manual SL/TP edits (the SAME real comparison the live EA webhook uses).",
    parameters: { type: "object", properties: { previousPositions: { type: "array" }, newPositions: { type: "array" } }, required: ["previousPositions", "newPositions"] },
    execute: async (args) => detectManualModifications(args.previousPositions as EaPosition[], args.newPositions as EaPosition[]),
  },
];
