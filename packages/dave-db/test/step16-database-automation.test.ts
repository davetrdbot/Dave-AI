import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DaveDatabase,
  registerScheduledTrigger,
  unregisterScheduledTrigger,
  computeNextFire,
  registerWebhookTrigger,
  createAutomationWebhookServer,
  WorkflowEngine,
} from "../src/index.js";

console.log("=== Step 16 real proof: Database + Automation ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-step16-"));
const dbPath = join(workDir, "dave.db");

try {
  // --- [1] 16.1: dynamic table creation, auto timestamps, real aggregate query ---
  console.log("[1] Dave creates its OWN table at runtime and runs a real aggregate query...\n");
  const db = new DaveDatabase(dbPath);
  db.createTable("trades_log", [
    { name: "symbol", type: "TEXT" },
    { name: "pnl", type: "REAL" },
  ]);
  assert.ok(db.listTables().includes("trades_log"));
  console.log(`    tables in the DB right now: ${db.listTables().join(", ")}`);

  const ids: string[] = [];
  for (const [symbol, pnl] of [["EURUSD", 42.5], ["EURUSD", -10], ["XAUUSD", 88], ["XAUUSD", -22], ["GBPUSD", 15]] as const) {
    ids.push(db.insert("trades_log", "user-1", { symbol, pnl }));
  }
  const first = db.getById("trades_log", "user-1", ids[0])!;
  assert.ok(typeof first.created_at === "number" && typeof first.updated_at === "number" && typeof first.id === "string");
  console.log(`    inserted ${ids.length} rows -- every one auto-got id/created_at/updated_at (row 1: ${JSON.stringify(first)})`);

  const sum = db.aggregate("trades_log", "user-1", "SUM", "pnl");
  const count = db.aggregate("trades_log", "user-1", "COUNT");
  const avg = db.aggregate("trades_log", "user-1", "AVG", "pnl");
  assert.equal(count, 5);
  assert.ok(Math.abs(sum - 113.5) < 0.001);
  assert.ok(Math.abs(avg - 22.7) < 0.001);
  console.log(`    real SQL aggregates -- SUM(pnl)=${sum}, COUNT(*)=${count}, AVG(pnl)=${avg}`);

  const eurusdOnly = db.query("trades_log", "user-1", { symbol: "EURUSD" });
  assert.equal(eurusdOnly.length, 2);
  console.log(`    filtered query (symbol=EURUSD) -> ${eurusdOnly.length} rows`);

  // --- [1b] Row-level security: a second user genuinely cannot see the first user's rows ---
  console.log("\n[1b] Row-level security: real enforcement, not a convention...\n");
  db.insert("trades_log", "user-2", { symbol: "EURUSD", pnl: 999 });
  const user1Rows = db.query("trades_log", "user-1", {});
  const user2Rows = db.query("trades_log", "user-2", {});
  assert.equal(user1Rows.length, 5);
  assert.equal(user2Rows.length, 1);
  assert.ok(!user1Rows.some((r) => r.pnl === 999), "user-1's query must never surface user-2's row");
  const user1AggIgnoresUser2 = db.aggregate("trades_log", "user-1", "COUNT");
  assert.equal(user1AggIgnoresUser2, 5, "aggregates are scoped by owner too, not just row reads");
  console.log(`    user-1 sees ${user1Rows.length} rows, user-2 sees ${user2Rows.length} -- no cross-user leakage, aggregates scoped too`);

  // --- [1c] Real transaction: atomic, rolls back on throw ---
  console.log("\n[1c] Real transaction -- atomic, rolls back on throw...\n");
  let threw = false;
  try {
    db.transaction(() => {
      db.insert("trades_log", "user-1", { symbol: "USDJPY", pnl: 1 });
      throw new Error("simulated mid-transaction failure");
    });
  } catch {
    threw = true;
  }
  assert.ok(threw);
  assert.equal(db.aggregate("trades_log", "user-1", "COUNT"), 5, "the USDJPY insert must have been rolled back, count still 5");
  console.log("    a throw mid-transaction rolled back the insert -- count is still 5, not 6");

  // --- [2] 16.2(b): entity trigger fires instantly on a real DB event ---
  console.log("\n[2] Entity trigger: fires synchronously the instant a row is created...\n");
  const entityEvents: unknown[] = [];
  const unsubscribe = db.onEntityEvent((event) => {
    if (event.table === "trades_log") entityEvents.push(event);
  });
  db.insert("trades_log", "user-1", { symbol: "NZDUSD", pnl: 7 });
  assert.equal(entityEvents.length, 1);
  assert.equal((entityEvents[0] as { op: string }).op, "created");
  console.log(`    real event fired: ${JSON.stringify(entityEvents[0])}`);
  const insertedId = (entityEvents[0] as { id: string }).id;
  db.update("trades_log", "user-1", insertedId, { pnl: 8 });
  db.deleteRow("trades_log", "user-1", insertedId);
  assert.deepEqual(entityEvents.map((e) => (e as { op: string }).op), ["created", "updated", "deleted"]);
  console.log("    update and delete also fired their own real events, in order");
  unsubscribe();

  // --- [3] 16.2(a): scheduled trigger genuinely runs, plus deterministic next-fire computation ---
  console.log("\n[3] Scheduled trigger: a real cron job actually fires (waiting on real wall-clock time)...\n");
  const nextFire = computeNextFire("0 9 * * 0", new Date("2026-09-04T12:00:00Z")); // every Sunday 09:00
  assert.equal(nextFire.getUTCDay(), 0);
  assert.equal(nextFire.getUTCHours(), 9);
  console.log(`    deterministic next-fire for "every Sunday 09:00" from 2026-09-04 (Fri) -> ${nextFire.toISOString()}`);

  let fireCount = 0;
  registerScheduledTrigger("test-tick", "* * * * * *", () => {
    fireCount++;
  });
  await new Promise((resolve) => setTimeout(resolve, 2200));
  unregisterScheduledTrigger("test-tick");
  assert.ok(fireCount >= 1, `expected the real cron job to have actually fired at least once in 2.2s, got ${fireCount}`);
  console.log(`    real node-cron job (every second) genuinely fired ${fireCount} time(s) in 2.2s of real wall-clock time`);

  // --- [4] 16.2(c): webhook trigger fires on a real external HTTP event ---
  console.log("\n[4] Webhook trigger: fires on a real external HTTP POST...\n");
  let webhookPayload: unknown;
  const hook = registerWebhookTrigger("external-price-alert", (payload) => {
    webhookPayload = payload;
  });
  const server = createAutomationWebhookServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  const res = await fetch(`http://127.0.0.1:${port}${hook.path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event: "price_crossed", symbol: "EURUSD", price: 1.09 }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(webhookPayload, { event: "price_crossed", symbol: "EURUSD", price: 1.09 });
  console.log(`    real HTTP POST to ${hook.path} -> handler received: ${JSON.stringify(webhookPayload)}`);
  await new Promise<void>((resolve) => server.close(() => resolve()));

  // --- [5] 16.3: multi-step workflow (call -> wait -> branch) genuinely completes, no polling, survives restart ---
  console.log("\n[5] Multi-step workflow (call -> wait -> branch), no polling, survives a real restart...\n");
  const callLog: string[] = [];
  const handlers = {
    fetch_balance: async () => (callLog.push("fetch_balance"), 550),
    notify_high: async () => (callLog.push("notify_high"), "notified: balance is high"),
    notify_low: async () => (callLog.push("notify_low"), "notified: balance is low"),
  };
  const conditions = {
    balance_over_500: (ctx: Record<string, unknown>) => (ctx.fetch_balance as number) > 500,
  };

  const engine1 = new WorkflowEngine(db, "user-1", handlers, conditions);
  const steps = [
    { type: "call" as const, name: "fetch_balance" },
    { type: "wait" as const, ms: 400 },
    { type: "branch" as const, condition: "balance_over_500", ifTrue: 3, ifFalse: 4 },
    { type: "call" as const, name: "notify_high", next: "end" as const },
    { type: "call" as const, name: "notify_low", next: "end" as const },
  ];
  const runId = engine1.start("balance-check", steps);
  // start() fires the first step's advance() without awaiting it (that's
  // deliberate -- start() itself must return synchronously with a runId).
  // Give the real async call-step handler a tick to actually resolve
  // before inspecting status.
  await new Promise((resolve) => setTimeout(resolve, 20));

  const midRun = engine1.getRun(runId)!;
  assert.equal(midRun.status, "waiting", "must genuinely pause at the wait step, not run straight through");
  assert.deepEqual(callLog, ["fetch_balance"]);
  console.log(`    after starting: status=${midRun.status}, stepIndex=${midRun.stepIndex} -- paused at the real wait step, no polling loop involved`);

  // Simulate a REAL process restart: engine1.shutdown() cancels its in-flight
  // setTimeout the same way a real process exit would kill every pending timer,
  // then open a brand-new WorkflowEngine against the SAME on-disk DB file and
  // prove it resumes from persisted state rather than restarting from step 0.
  console.log("    simulating a process restart -- killing engine1's timer, new WorkflowEngine instance, same DB file...");
  engine1.shutdown();
  const engine2 = new WorkflowEngine(db, "user-1", handlers, conditions);
  const recovered = engine2.recoverPendingRuns();
  assert.equal(recovered, 1);
  console.log(`    recoverPendingRuns() found ${recovered} run still waiting and rescheduled exactly one timer for it`);

  await new Promise((resolve) => setTimeout(resolve, 700));
  const finalRun = engine2.getRun(runId)!;
  assert.equal(finalRun.status, "completed");
  assert.deepEqual(callLog, ["fetch_balance", "notify_high"]);
  assert.equal(finalRun.context.notify_high, "notified: balance is high");
  console.log(`    workflow completed after the simulated restart -- calls made: ${callLog.join(", ")}, final context: ${JSON.stringify(finalRun.context)}`);
  console.log("    correct branch taken (balance 550 > 500 -> notify_high, notify_low never called)");

  db.close();
  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
