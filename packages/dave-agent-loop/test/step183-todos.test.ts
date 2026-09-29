import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DAVE_DATA_ROOT = mkdtempSync(join(tmpdir(), "dave-todos-"));

const { createTodoTool, getTodos, activeTodos, todoContinuation, resumeUnfinishedTodos, todoContextBlock, MAX_AUTO_RESUMES } = await import("../src/todos.js");

const U = "todo-user";
const tool = createTodoTool(U);

// Bad input is refused with a clear message.
await assert.rejects(() => tool.execute({ todos: [] }), /whole list/);
await assert.rejects(() => tool.execute({ todos: [{ text: "", status: "pending" }] }), /no text/);

// First call: the whole list; only one item may be in progress.
const t0 = Date.now() - 10;
let r = (await tool.execute({
  todos: [
    { text: "Check gold", status: "in_progress" },
    { text: "Move EURUSD to breakeven", status: "in_progress" },
    { text: "Today's P&L", status: "weird" },
  ],
})) as { todos: { status: string }[]; done: number; total: number; next: string; instruction: string };
assert.deepEqual(r.todos.map((t) => t.status), ["in_progress", "pending", "pending"]);
assert.equal(r.total, 3);
assert.equal(r.next, "1. Check gold");
assert.match(r.instruction, /3 left/);
assert.ok(activeTodos(U));
assert.match(todoContextBlock(U)!, /\[>\] 1\. Check gold/);

// Continuation: after a finished turn or a deadline, never after /stop or a question.
assert.match(todoContinuation(U, t0, { status: "done" })!, /0 of 3 done/);
assert.ok(todoContinuation(U, t0, { status: "aborted", reason: "deadline" }));
assert.equal(todoContinuation(U, t0, { status: "aborted", reason: "cancelled" }), null);
assert.equal(todoContinuation(U, t0, { status: "awaiting_user" }), null);
// A list this turn didn't touch never restarts on its own.
assert.equal(todoContinuation(U, Date.now() + 1000, { status: "done" }), null);

// resumeUnfinishedTodos: the rerun finishes the list, so it stops after one extra run.
let runs = 0;
const intermediates: string[] = [];
const final = await resumeUnfinishedTodos(
  U,
  t0,
  { status: "aborted", reason: "deadline", history: [{ role: "user", content: "do three things" }] },
  async (h) => {
    runs++;
    assert.match(String(h.at(-1)!.content), /Carry on from where you stopped/);
    await tool.execute({ todos: [{ text: "Check gold", status: "done", note: "ranging" }, { text: "Move EURUSD to breakeven", status: "done" }, { text: "Today's P&L", status: "blocked", note: "EA offline" }] });
    return { status: "done", history: h };
  },
  (_res, progress) => {
    intermediates.push(progress);
  }
);
assert.equal(runs, 1);
assert.equal(final.status, "done");
assert.deepEqual(intermediates, ["0/3"]);
assert.equal(activeTodos(U), null, "a finished list (done + blocked) is no longer active");
assert.equal(todoContextBlock(U), null);

// The resume cap: a model that never finishes gets at most MAX_AUTO_RESUMES extra runs.
await tool.execute({ todos: [{ text: "A", status: "pending" }, { text: "B", status: "pending" }] });
assert.equal(getTodos(U)!.resumes, 0, "a new list starts its own resume count");
let loops = 0;
await resumeUnfinishedTodos(U, t0, { status: "done", history: [] as { role: string; content: unknown }[] }, async (h) => {
  loops++;
  await tool.execute({ todos: [{ text: "A", status: "in_progress" }, { text: "B", status: "pending" }] });
  return { status: "done", history: h };
});
assert.equal(loops, MAX_AUTO_RESUMES);

// Too many items is refused.
await assert.rejects(() => tool.execute({ todos: Array.from({ length: 21 }, (_, i) => ({ text: `t${i}`, status: "pending" })) }), /At most/);

console.log("step183 todos: ok");
