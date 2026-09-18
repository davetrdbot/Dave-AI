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

/**
 * Real bug fixed (the trader, live, with his own timeline: "hi" around 10:11, "trade" around
 * 10:21, "pending" around 10:22 -- "it likes send all of that to the bot which is not good", and
 * the bot then "kept on repeating what he just sent"). The delegate:pause handler used to run a
 * SEPARATE full agent turn per queued message, so three messages sent minutes apart fired three
 * complete turns back to back, each re-reading the same history and re-answering from scratch.
 * That is exactly how one trade question produced four near-identical essays.
 *
 * A person coming back to three missed messages answers them ONCE, together. This collapses the
 * backlog per chat, preserving the original send order, so the caller runs one turn per chat
 * instead of one per message.
 */
export interface CollapsedDelegation {
  chatId: number;
  /** The single prompt to run -- the message verbatim when there is only one, so a lone queued
   *  message is never wrapped in backlog scaffolding it does not need. */
  text: string;
  /** How many real messages this represents, for the caller's own acknowledgement copy. */
  count: number;
}

export function collapseQueuedMessages(queue: PendingDelegation[]): CollapsedDelegation[] {
  const byChat = new Map<number, string[]>();
  for (const item of queue) {
    const existing = byChat.get(item.chatId);
    if (existing) existing.push(item.text);
    else byChat.set(item.chatId, [item.text]);
  }
  return [...byChat.entries()].map(([chatId, texts]) => ({
    chatId,
    count: texts.length,
    text:
      texts.length === 1
        ? texts[0]
        : `While you were busy I sent you these, in this order -- answer them together in ONE reply, don't repeat yourself once per message:\n` +
          texts.map((t, i) => `${i + 1}. ${t}`).join("\n"),
  }));
}

function delegationPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "agent-loop", userId, "pending-delegation.json");
}

/** Real bug fixed (user, live: two messages minutes apart got answered "bundled" together --
 *  root-caused to this file overwriting, not queueing). A THIRD message arriving before the user
 *  ever answered the button prompt for the SECOND used to silently discard it (this file held
 *  exactly one entry, and setPendingDelegation always replaced it). Every message that arrives
 *  while busy is now appended, never dropped -- the storage shape is an array. */
function readDelegationQueue(userId: string): PendingDelegation[] {
  const path = delegationPath(userId);
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (Array.isArray(parsed)) return parsed as PendingDelegation[];
  // Back-compat with the old single-object shape, in case a file from before this fix is read.
  return parsed ? [parsed as PendingDelegation] : [];
}

function writeDelegationQueue(userId: string, queue: PendingDelegation[]): void {
  const path = delegationPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(queue), "utf8");
}

/** Appends a new message to the queue rather than replacing whatever was already pending. */
export function addPendingDelegation(userId: string, delegation: PendingDelegation): void {
  const queue = readDelegationQueue(userId);
  queue.push(delegation);
  writeDelegationQueue(userId, queue);
}

/** Clears the whole queue -- used once the user has picked an option for it. */
export function clearPendingDelegation(userId: string): void {
  writeDelegationQueue(userId, []);
}

/** Every message that queued up while busy, oldest first. Empty array, never null, when there's
 *  nothing pending -- callers no longer need to special-case null vs. an empty list. */
export function getPendingDelegationQueue(userId: string): PendingDelegation[] {
  return readDelegationQueue(userId);
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
