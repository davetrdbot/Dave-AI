import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { coloredButton, keyboard, type InlineKeyboardMarkup } from "@dave/telegram";
import type { BusyState } from "./busy-state.js";

/**
 * Real gap fixed (user: "if a new request comes in while Dave is busy with something else,
 * Dave doesn't just silently switch or silently ignore it. It estimates roughly how long the
 * competing task will take, then sends a message with 3 colored buttons: Pause and do it
 * myself / Hand it to a worker / Skip it"). This is the "a second message arrived while busy"
 * half: the new message's real content is held here until the user picks one of the three
 * real options, rather than either silently interleaving both or silently dropping the new one.
 */
export interface PendingDelegation {
  text: string;
  chatId: number;
}

function delegationPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "agent-loop", userId, "pending-delegation.json");
}

export function setPendingDelegation(userId: string, delegation: PendingDelegation | null): void {
  const path = delegationPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(delegation), "utf8");
}

export function getPendingDelegation(userId: string): PendingDelegation | null {
  const path = delegationPath(userId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Honest, rough estimate -- no historical per-task-type timing data exists to draw on, so
 * this reports what's actually knowable (elapsed time so far) rather than fabricating a
 * confident-sounding prediction it has no real basis for. */
export function describeBusyDuration(busy: BusyState, now = Date.now()): string {
  const elapsedSec = Math.round((now - busy.startedAt) / 1000);
  return elapsedSec < 5 ? "just started" : `running for about ${elapsedSec}s so far`;
}

export function buildDelegationPrompt(busy: BusyState): { text: string; reply_markup: InlineKeyboardMarkup } {
  const text = `Still finishing your last message: ${busy.taskDescription} (${describeBusyDuration(busy)}). You sent something new -- want me to pause and do it myself, hand it to a worker, or skip it?`;
  const reply_markup = keyboard([
    [coloredButton("Pause and do it myself", "blue", "delegate:pause"), coloredButton("Hand it to a worker", "green", "delegate:worker")],
    [coloredButton("Skip it", "red", "delegate:skip")],
  ]);
  return { text, reply_markup };
}
