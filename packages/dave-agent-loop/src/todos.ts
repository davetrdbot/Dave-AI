import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Dave's to-do list (the trader: "if they give the bot multi task, it will just create todos and do
 * it all"). When one message asks for several things, Dave writes them down as a checklist first,
 * works through them one at a time -- marking each in progress, then done -- and only answers once
 * the list is finished. The app shows the list live; a turn that runs out of time with items left
 * picks the list up again on its own.
 */

export type TodoStatus = "pending" | "in_progress" | "done" | "blocked";

export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
  /** What came of it (done) or what's in the way (blocked). */
  note?: string;
}

export interface TodoList {
  items: TodoItem[];
  createdAt: number;
  updatedAt: number;
  /** How many times an unfinished list has been resumed automatically. */
  resumes: number;
}

export const MAX_TODOS = 20;
/** An unfinished list older than this is stale -- it no longer rides along in Dave's context. */
export const TODO_STALE_MS = 12 * 3_600_000;
export const MAX_AUTO_RESUMES = 3;

function path(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "agent", userId, "todos.json");
}

export function getTodos(userId: string): TodoList | null {
  try {
    if (existsSync(path(userId))) return JSON.parse(readFileSync(path(userId), "utf8")) as TodoList;
  } catch {
    /* a broken file is no list */
  }
  return null;
}

function save(userId: string, list: TodoList): void {
  mkdirSync(dirname(path(userId)), { recursive: true });
  writeFileSync(path(userId), JSON.stringify(list, null, 2), "utf8");
}

export const openTodos = (list: TodoList | null) => (list?.items ?? []).filter((t) => t.status === "pending" || t.status === "in_progress");

/** An unfinished, recent list -- the one Dave is working through. */
export function activeTodos(userId: string, now = Date.now()): TodoList | null {
  const list = getTodos(userId);
  if (!list || now - list.updatedAt > TODO_STALE_MS) return null;
  return openTodos(list).length ? list : null;
}

const STATUSES: TodoStatus[] = ["pending", "in_progress", "done", "blocked"];

/** Replaces the list (the model always sends the whole thing, so nothing drifts). */
export function writeTodos(userId: string, raw: unknown, now = Date.now()): TodoList {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("Send the whole list: todos = [{text, status}, ...].");
  if (raw.length > MAX_TODOS) throw new Error(`At most ${MAX_TODOS} items -- group the small ones.`);
  const prev = getTodos(userId);
  const items: TodoItem[] = raw.map((r, i) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const text = String(o.text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!text) throw new Error(`Item ${i + 1} has no text.`);
    const status = STATUSES.includes(o.status as TodoStatus) ? (o.status as TodoStatus) : "pending";
    const note = typeof o.note === "string" && o.note.trim() ? o.note.trim().slice(0, 300) : undefined;
    return { id: String(i + 1), text, status, ...(note ? { note } : {}) };
  });
  const inProgress = items.filter((t) => t.status === "in_progress");
  // One thing at a time: a second "in progress" goes back to pending.
  for (const t of inProgress.slice(1)) t.status = "pending";
  const fresh = !prev || openTodos(prev).length === 0 || now - prev.updatedAt > TODO_STALE_MS;
  const list: TodoList = { items, createdAt: fresh ? now : prev!.createdAt, updatedAt: now, resumes: fresh ? 0 : prev!.resumes };
  save(userId, list);
  return list;
}

export function markResumed(userId: string): number {
  const list = getTodos(userId);
  if (!list) return 0;
  list.resumes++;
  save(userId, list);
  return list.resumes;
}

export function clearTodos(userId: string): void {
  const list = getTodos(userId);
  if (!list) return;
  save(userId, { ...list, items: list.items.map((t) => (t.status === "done" ? t : { ...t, status: "blocked" as const, note: t.note ?? "dropped" })), updatedAt: Date.now() });
}

const mark = (s: TodoStatus) => (s === "done" ? "[x]" : s === "in_progress" ? "[>]" : s === "blocked" ? "[!]" : "[ ]");

export function renderTodos(list: TodoList): string {
  return list.items.map((t) => `${mark(t.status)} ${t.id}. ${t.text}${t.note ? ` -- ${t.note}` : ""}`).join("\n");
}

/** For Dave's context: the list he's in the middle of. */
export function todoContextBlock(userId: string): string | null {
  const list = activeTodos(userId);
  if (!list) return null;
  return `YOUR TO-DO LIST (unfinished -- keep going, update it with update_todos as you finish each):\n${renderTodos(list)}`;
}

/**
 * After a turn ends: the message that carries on an unfinished list, or null. Only a list this turn
 * touched counts (an old one never restarts on its own), only after a finished turn or one that ran
 * out of time (never after /stop or a question), and at most MAX_AUTO_RESUMES times per list.
 */
export function todoContinuation(userId: string, turnStartedAt: number, result: { status: string; reason?: string }): string | null {
  if (!(result.status === "done" || (result.status === "aborted" && result.reason === "deadline"))) return null;
  const list = activeTodos(userId);
  if (!list || list.updatedAt < turnStartedAt || list.resumes >= MAX_AUTO_RESUMES) return null;
  const done = list.items.filter((t) => t.status === "done").length;
  return `(Automatic) Your to-do list isn't finished -- ${done} of ${list.items.length} done. Carry on from where you stopped; don't redo finished items. Update the list as you go and give ONE summary when it's done:\n${renderTodos(list)}`;
}

/**
 * Runs `first`'s continuations until the list is done (or the resume cap). `rerun` runs the loop
 * again over the given history; `onIntermediate` gets each result that is followed by another run.
 */
export async function resumeUnfinishedTodos<R extends { status: string; reason?: string; history: { role: string; content: unknown }[] }>(
  userId: string,
  turnStartedAt: number,
  first: R,
  rerun: (history: R["history"]) => Promise<R>,
  onIntermediate?: (result: R, doneOf: string) => void | Promise<void>
): Promise<R> {
  let result = first;
  for (;;) {
    const next = todoContinuation(userId, turnStartedAt, result as { status: string; reason?: string });
    if (!next) return result;
    const n = markResumed(userId);
    const list = getTodos(userId)!;
    await onIntermediate?.(result, `${list.items.filter((t) => t.status === "done").length}/${list.items.length}`);
    console.log(`[todos] ${userId}: resuming an unfinished list (${n}/${MAX_AUTO_RESUMES})`);
    const history = [...result.history, { role: "user", content: next }] as R["history"];
    result = await rerun(history);
  }
}

/** The chat tool. */
export function createTodoTool(userId: string) {
  return {
    name: "update_todos",
    description:
      "Your to-do list for a request with several parts. Use it whenever the trader asks for 2+ separate things in one message (\"check gold, move EURUSD to breakeven, and tell me today's P&L\"), or a task has several steps. " +
      "FIRST call: write every item, all 'pending' (or the first 'in_progress'). Then work through them in order: set one 'in_progress', do it with your tools, set it 'done' with a short note of the result, move to the next. " +
      "Mark an item 'blocked' (with the reason) instead of silently skipping it. Always send the WHOLE list. Only give your final answer once nothing is pending or in progress -- then answer with one summary covering every item.",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          maxItems: MAX_TODOS,
          items: {
            type: "object",
            properties: {
              text: { type: "string", description: "the task, short and specific" },
              status: { type: "string", enum: STATUSES },
              note: { type: "string", description: "result when done, reason when blocked" },
            },
            required: ["text", "status"],
          },
        },
      },
      required: ["todos"],
    },
    execute: async (args: Record<string, unknown>) => {
      const list = writeTodos(userId, args.todos);
      const open = openTodos(list);
      const next = list.items.find((t) => t.status === "in_progress") ?? list.items.find((t) => t.status === "pending");
      return {
        todos: list.items,
        done: list.items.filter((t) => t.status === "done").length,
        total: list.items.length,
        next: next ? `${next.id}. ${next.text}` : null,
        instruction: open.length
          ? `Keep going -- ${open.length} left. Do "${next!.text}" now (mark it in_progress), then update the list.`
          : "All done. Give the trader ONE summary covering every item (and any blocked ones, with why).",
      };
    },
  };
}
