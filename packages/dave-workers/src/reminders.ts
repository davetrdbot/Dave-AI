import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Dave's own reminders -- notes to his future self (the trader: "give the bot reminders so the
 * bot can remind itself of something, and also give it delete reminder").
 *
 * Different from a background check on purpose. A background check polls a condition with a
 * model call every tick; a reminder is only a clock: "at this time, bring this back to me, with
 * the reason I had". Cheap enough to set freely, from chat or from an autonomous cycle.
 *
 * Every reminder carries the REASON it was set (the trader: "it should come up with the idea what
 * made him put the reminder"), stored verbatim and shown again when it fires -- a reminder that
 * says "check VOL_80" with no why is useless an hour later.
 *
 * The store is a file, like every other cross-process value here: the bot fires reminders, and
 * the admin process (the phone app) can read them.
 */

export type ReminderSource = "chat" | "autonomous";
export type ReminderStatus = "pending" | "fired";

export interface Reminder {
  id: string;
  /** What to remember, in Dave's words -- what to do or check when it fires. */
  text: string;
  /** WHY it was set: the idea or observation behind it. Resurfaced verbatim when it fires. */
  reason: string;
  /** Optional symbol it is about. An autonomous cycle analyses this symbol next when it fires. */
  symbol?: string;
  dueAt: number;
  createdAt: number;
  source: ReminderSource;
  status: ReminderStatus;
  firedAt?: number;
}

/** Shortest and longest delays accepted. A reminder is for later, not for "right now", and never
 *  for so far out that it outlives the idea behind it. */
export const MIN_REMINDER_MINUTES = 1;
export const MAX_REMINDER_MINUTES = 30 * 24 * 60; // 30 days
/** Ceiling on pending reminders, so a runaway loop cannot bury the store (or Dave's context). */
export const MAX_PENDING_REMINDERS = 30;
/** A fired reminder stays visible to Dave this long so he can act on it, then it is dropped. */
export const FIRED_REMINDER_TTL_MS = 3 * 60 * 60_000; // 3h

export function remindersPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "reminders", userId, "reminders.json");
}

function read(userId: string): Reminder[] {
  const path = remindersPath(userId);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((r): r is Reminder => typeof r?.id === "string" && typeof r?.dueAt === "number") : [];
  } catch {
    return []; // a corrupt file must never break a turn or a cycle
  }
}

function save(userId: string, reminders: Reminder[]): void {
  const path = remindersPath(userId);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(reminders, null, 2), "utf8");
}

/** Drops fired reminders older than the TTL. */
function prune(reminders: Reminder[], now: number): Reminder[] {
  return reminders.filter((r) => r.status === "pending" || (r.firedAt ?? r.dueAt) + FIRED_REMINDER_TTL_MS > now);
}

export interface CreateReminderOptions {
  text: string;
  reason: string;
  /** Minutes from now. Either this or `at`. */
  inMinutes?: number;
  /** Absolute time (ISO string or epoch ms). Either this or `inMinutes`. */
  at?: string | number;
  symbol?: string;
  source?: ReminderSource;
}

export function createReminder(userId: string, options: CreateReminderOptions, now = Date.now()): Reminder {
  const text = options.text?.trim();
  const reason = options.reason?.trim();
  if (!text) throw new Error("text is required -- what should you be reminded to do or check?");
  if (!reason) throw new Error("reason is required -- the idea or observation that made you set this, so it still makes sense when it fires.");

  let dueAt: number;
  if (options.inMinutes !== undefined && options.inMinutes !== null) {
    const minutes = Number(options.inMinutes);
    if (!Number.isFinite(minutes)) throw new Error("inMinutes must be a number.");
    dueAt = now + Math.round(Math.min(Math.max(minutes, MIN_REMINDER_MINUTES), MAX_REMINDER_MINUTES) * 60_000);
  } else if (options.at !== undefined && options.at !== null && options.at !== "") {
    const parsed = typeof options.at === "number" ? options.at : Date.parse(options.at);
    if (!Number.isFinite(parsed)) throw new Error(`Could not read the time "${options.at}" -- use an ISO time like 2026-09-23T18:30:00Z, or inMinutes.`);
    if (parsed <= now) throw new Error("That time has already passed -- pick a time in the future.");
    if (parsed > now + MAX_REMINDER_MINUTES * 60_000) throw new Error("Reminders can be at most 30 days out.");
    dueAt = parsed;
  } else {
    throw new Error("Say when: inMinutes (from now) or at (an ISO time).");
  }

  const reminders = prune(read(userId), now);
  if (reminders.filter((r) => r.status === "pending").length >= MAX_PENDING_REMINDERS) {
    throw new Error(`You already have ${MAX_PENDING_REMINDERS} pending reminders -- delete ones you no longer need first.`);
  }
  const reminder: Reminder = {
    id: randomBytes(4).toString("hex"),
    text,
    reason,
    symbol: options.symbol?.trim() ? options.symbol.trim().toUpperCase() : undefined,
    dueAt,
    createdAt: now,
    source: options.source ?? "chat",
    status: "pending",
  };
  reminders.push(reminder);
  save(userId, reminders);
  return reminder;
}

/** Pending reminders soonest first, then recently fired ones (newest first) when asked. */
export function listReminders(userId: string, options: { includeFired?: boolean } = {}, now = Date.now()): Reminder[] {
  const all = prune(read(userId), now);
  const pending = all.filter((r) => r.status === "pending").sort((a, b) => a.dueAt - b.dueAt);
  if (!options.includeFired) return pending;
  const fired = all.filter((r) => r.status === "fired").sort((a, b) => (b.firedAt ?? 0) - (a.firedAt ?? 0));
  return [...pending, ...fired];
}

/** Removes a reminder, pending or fired. Returns the removed one, or undefined if no such id. */
export function deleteReminder(userId: string, id: string): Reminder | undefined {
  const reminders = read(userId);
  const target = reminders.find((r) => r.id === id.trim());
  if (!target) return undefined;
  save(
    userId,
    reminders.filter((r) => r !== target),
  );
  return target;
}

/** Marks every reminder that is due as fired and returns them, oldest first. Each is returned
 *  exactly once -- the caller delivers it. */
export function takeDueReminders(userId: string, now = Date.now()): Reminder[] {
  const reminders = read(userId);
  const due = reminders.filter((r) => r.status === "pending" && r.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt);
  if (due.length === 0) return [];
  for (const r of due) {
    r.status = "fired";
    r.firedAt = now;
  }
  save(userId, prune(reminders, now));
  return due;
}

function whenLabel(ms: number, now: number): string {
  const diff = Math.round((ms - now) / 60_000);
  const abs = Math.abs(diff);
  const span = abs < 60 ? `${abs}m` : abs < 48 * 60 ? `${Math.floor(abs / 60)}h${abs % 60 ? ` ${abs % 60}m` : ""}` : `${Math.round(abs / 1440)}d`;
  return diff >= 0 ? `in ${span}` : `${span} ago`;
}

/** One line per reminder, for Dave's own context (chat turn and autonomous cycle alike). */
export function formatReminderLine(r: Reminder, now = Date.now()): string {
  const when = r.status === "fired" ? `FIRED ${whenLabel(r.firedAt ?? r.dueAt, now)}` : `due ${whenLabel(r.dueAt, now)} (${new Date(r.dueAt).toISOString().slice(0, 16)}Z)`;
  return `- [${r.id}] ${when}${r.symbol ? ` · ${r.symbol}` : ""} -- ${r.text} (why: ${r.reason})`;
}

/** The chat message sent when a reminder fires. */
export function describeFiredReminder(r: Reminder): string {
  return `⏰ Reminder${r.symbol ? ` · ${r.symbol}` : ""}\n${r.text}\n\nWhy I set it: ${r.reason}`;
}

export interface ReminderToolContext {
  ownerUserId: string;
}

export interface ReminderToolDefinitionShape {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: ReminderToolContext) => Promise<unknown>;
}

export const REMINDER_TOOLS: ReminderToolDefinitionShape[] = [
  {
    name: "set_reminder",
    description:
      "Set a reminder for your future self: at a set time it comes back to you (and to the trader, as a message and a phone notification) with what to do AND the reason you set it. Use it whenever you notice something worth coming back to later -- a candle close to wait for, a level price hasn't reached yet, a session opening, a trade to review after it has had time to play out, something the trader asked you to follow up on. Cheaper than a background check: it only waits for the time, it does not poll the market.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "What to do or check when it fires, written so it makes sense on its own later (e.g. \"Re-check VOL_80 for a long after the H1 candle closes\")." },
        reason: {
          type: "string",
          description: "REQUIRED: the idea or observation that made you set it, in your own words (e.g. \"H1 is sitting on the 196500 demand zone but M15 is still falling -- wanted the close to confirm\"). Shown back to you verbatim when it fires.",
        },
        inMinutes: { type: "number", description: `Minutes from now (${MIN_REMINDER_MINUTES} to ${MAX_REMINDER_MINUTES}). Use this or at.` },
        at: { type: "string", description: "Exact time as ISO 8601 UTC (e.g. 2026-09-23T18:30:00Z). Use this or inMinutes." },
        symbol: { type: "string", description: "Optional symbol it is about. When it fires during autonomous trading, that symbol is analysed next." },
      },
      required: ["text", "reason"],
    },
    execute: async (args, ctx) =>
      createReminder(ctx.ownerUserId, {
        text: String(args.text ?? ""),
        reason: String(args.reason ?? ""),
        inMinutes: args.inMinutes as number | undefined,
        at: args.at as string | undefined,
        symbol: args.symbol as string | undefined,
        source: "chat",
      }),
  },
  {
    name: "list_reminders",
    description: "List your reminders: pending ones soonest first, and (with includeFired) ones that fired in the last few hours.",
    parameters: { type: "object", properties: { includeFired: { type: "boolean" } } },
    execute: async (args, ctx) => listReminders(ctx.ownerUserId, { includeFired: Boolean(args.includeFired) }),
  },
  {
    name: "delete_reminder",
    description: "Delete a reminder by id -- one that no longer matters, or one that fired and you have dealt with.",
    parameters: { type: "object", properties: { reminderId: { type: "string" } }, required: ["reminderId"] },
    execute: async (args, ctx) => {
      const removed = deleteReminder(ctx.ownerUserId, String(args.reminderId ?? ""));
      if (!removed) throw new Error(`No reminder "${args.reminderId}".`);
      return { ok: true, deleted: removed };
    },
  },
];
