import assert from "node:assert/strict";
import type { TradeMonitor } from "../src/trade-monitor-store.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Two real, live-reported bugs.
 *
 * 1. "Breakeven doesn't work and reason not added" -- the trader, quoting the alert verbatim:
 *      🎯 VOL_80 SELL (ticket #1181881881) is up about 1R -- enough to move the stop to breakeven
 *      📌 Original idea: (reason not recorded)
 *    Both halves were real. The sweep's deps carried ONLY `notify`, so the alert could suggest
 *    moving the stop and, by construction, nothing could ever move it. And the reason was a cache
 *    latch: `??` only falls through on null, so once "(reason not recorded)" was cached the journal
 *    was never consulted again for the life of the trade.
 *
 * 2. "This message should get deleted after 10 s" -- the key-rotation notice sat in the chat
 *    forever, including when a later key answered and the turn completed normally.
 */

const workDir = mkdtempSync(join(tmpdir(), "dave-step149-"));
process.env.DAVE_DATA_ROOT = workDir;

const { runTradeMonitorSweep, buildMonitorAlert } = await import("../src/trade-monitor-sweep.js");
const { writeMonitors, readMonitors, REASON_NOT_RECORDED } = await import("../src/trade-monitor-store.js");
const { TRANSIENT_NOTICE_MS } = await import("../src/provider-selection.js");
const { scheduleSelfDelete, sendSelfDeletingMessage, SELF_DELETE_DELAY_MS } = await import("@dave/telegram");
const { DaveDatabase } = await import("@dave/db");
const { logTrade } = await import("@dave/feedback");

const OWNER = "trader-1";
const TICKET = "1181881881";
const repoRoot = join(import.meta.dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(repoRoot, p), "utf8");

/** The EA snapshot the sweep reads -- a VOL_80 SELL sitting well in profit, as in the real report. */
function seedPosition(opts: { pnl: number; currentPrice: number }) {
  const dir = join(workDir, "data", "ea-bridge", OWNER);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "last-known-state.json"),
    JSON.stringify({
      positions: [{ ticket: TICKET, symbol: "VOL_80", type: "sell", lots: 0.02, openPrice: 196800, sl: 197000, tp: 196000, currentPrice: opts.currentPrice, pnl: opts.pnl }],
      pendingOrders: [],
    })
  );
}

console.log("=== Breakeven genuinely moves the stop; the key notice genuinely disappears ===\n");

const db = new DaveDatabase(join(workDir, "dave.db"));

console.log("[1] THE BUG: with no executor the sweep could only ever talk...\n");
{
  // This is the shipped behaviour the trader saw: an alert that suggests, and nothing that acts.
  seedPosition({ pnl: 24.29, currentPrice: 196500 });
  writeMonitors(OWNER, []);
  const sent: string[] = [];
  const fired = await runTradeMonitorSweep({ db, userId: OWNER, notify: async (t) => void sent.push(t) });
  assert.ok(fired.some((a) => a.kind === "breakeven"), "the breakeven alert itself always did fire");
  assert.match(sent.join("\n"), /enough to move the stop to breakeven/, "…and only ever suggested it");
  console.log("    confirmed: reproduced -- alert fires, nothing moves (no executor wired)");
}

console.log("\n[2] THE FIX: with a real executor the stop is genuinely moved to entry...\n");
{
  seedPosition({ pnl: 24.29, currentPrice: 196500 });
  writeMonitors(OWNER, []);
  const calls: { ticket: string; changes: Record<string, unknown> }[] = [];
  const sent: string[] = [];
  const executor = {
    openOrder: async () => ({ ticket: "x" }),
    modifyOrder: async (ticket: string, changes: Record<string, unknown>) => void calls.push({ ticket, changes }),
    closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
    deletePendingOrder: async () => {},
    listOpenPositions: async () => [],
    listPendingOrders: async () => [],
  } as never;

  await runTradeMonitorSweep({ db, userId: OWNER, executor, notify: async (t) => void sent.push(t) });
  assert.equal(calls.length, 1, `modifyOrder must genuinely be called once, got ${calls.length}`);
  assert.equal(calls[0].ticket, TICKET, "on the real ticket from the alert");
  assert.equal(calls[0].changes.sl, 196800, "stop moved to the ENTRY price -- that is what breakeven means");
  assert.match(sent.join("\n"), /I've moved the stop to breakeven \(196800\)/, "the message states what happened");
  assert.match(sent.join("\n"), /risk-free/i);
  assert.ok(!sent.join("\n").includes("enough to move the stop"), "it must no longer merely suggest it");
  console.log(`    confirmed: real modifyOrder(#${TICKET}, sl=196800) + a message that reports the fact`);
}

console.log("\n[3] A broker that REFUSES the move is reported honestly, never glossed over...\n");
{
  seedPosition({ pnl: 24.29, currentPrice: 196500 });
  writeMonitors(OWNER, []);
  const sent: string[] = [];
  const executor = {
    openOrder: async () => ({ ticket: "x" }),
    modifyOrder: async () => { throw new Error("invalid stops"); },
    closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
    deletePendingOrder: async () => {},
    listOpenPositions: async () => [],
    listPendingOrders: async () => [],
  } as never;

  await runTradeMonitorSweep({ db, userId: OWNER, executor, notify: async (t) => void sent.push(t) });
  const msg = sent.join("\n");
  assert.match(msg, /could NOT move the stop to breakeven/, "a failed move must say so");
  assert.match(msg, /invalid stops/, "…with the real broker reason");
  assert.match(msg, /still carrying full risk/, "…and must not imply the trade is protected");
  console.log("    confirmed: failure surfaces the real reason and the real risk state");
}

console.log("\n[4] A failed move is never retried every 30 seconds...\n");
{
  seedPosition({ pnl: 24.29, currentPrice: 196500 });
  writeMonitors(OWNER, []);
  let attempts = 0;
  const executor = {
    openOrder: async () => ({ ticket: "x" }),
    modifyOrder: async () => { attempts += 1; throw new Error("invalid stops"); },
    closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
    deletePendingOrder: async () => {},
    listOpenPositions: async () => [],
    listPendingOrders: async () => [],
  } as never;
  const deps = { db, userId: OWNER, executor, notify: async () => {} };
  await runTradeMonitorSweep(deps);
  await runTradeMonitorSweep(deps);
  await runTradeMonitorSweep(deps);
  assert.equal(attempts, 1, `a broker refusing this stop will keep refusing it -- got ${attempts} attempts`);
  console.log("    confirmed: latched after one attempt across 3 sweeps");
}

console.log("\n[5] THE REASON BUG: a cached placeholder used to stick forever...\n");
{
  seedPosition({ pnl: 24.29, currentPrice: 196500 });
  // Exactly the real race: the first sweep ran before logTrade landed, so the monitor cached the
  // placeholder. Under the old `??` this was served for the rest of the trade's life.
  const stale: TradeMonitor = {
    ticket: TICKET, symbol: "VOL_80", direction: "sell", openPrice: 196800, sl: 197000, tp: 196000,
    reason: REASON_NOT_RECORDED, openedAt: Date.now() - 60_000, state: "profit", history: [], alerts: {}, updatedAt: Date.now(),
  };
  writeMonitors(OWNER, [stale]);
  // The journal row lands a moment later, as it really does.
  logTrade(db, OWNER, {
    ticket: TICKET, symbol: "VOL_80", direction: "sell", entryPrice: 196800, sl: 197000, tp: 196000,
    reasoning: ["swept the session high and rejected, short back into the range"], confluenceScore: 72,
  });

  const sent: string[] = [];
  await runTradeMonitorSweep({ db, userId: OWNER, notify: async (t) => void sent.push(t) });
  const after = readMonitors(OWNER).find((m) => m.ticket === TICKET)!;
  assert.equal(after.reason, "swept the session high and rejected, short back into the range", "the real reason must be picked up on the very next sweep");
  assert.notEqual(after.reason, REASON_NOT_RECORDED);
  console.log("    confirmed: placeholder treated as a cache miss, real reason adopted");
}

console.log("\n[6] …and once adopted, every alert quotes it...\n");
{
  const m = readMonitors(OWNER).find((x) => x.ticket === TICKET)!;
  const msg = buildMonitorAlert({ kind: "breakeven", monitor: m }, Date.now(), { status: "moved", level: 196800 });
  assert.match(msg, /📌 Original idea: swept the session high and rejected/, "the alert carries the real idea");
  assert.ok(!msg.includes(REASON_NOT_RECORDED), "and never the placeholder");
  console.log("    confirmed: the exact alert the trader complained about now carries its thesis");
}

console.log("\n[7] trade_execute now REQUIRES a reason -- the write-side root cause...\n");
{
  const { TRADING_TOOLS } = await import("@dave/trading");
  const exec = TRADING_TOOLS.find((t) => t.name === "trade_execute")!;
  const params = exec.parameters as { required: string[]; properties: Record<string, { description?: string }> };
  assert.ok(params.required.includes("reason"), "optional was exactly why the journal got an empty array");
  assert.match(params.properties.reason.description ?? "", /REQUIRED/);
  assert.ok(!(params.properties.reason.description ?? "").includes("if approval is needed"), "the old framing told the model it only mattered for approvals");
  console.log("    confirmed: reason is required and described as the trade's thesis");
}

console.log("\n[8] The key-switch notice is marked transient; a dead provider is not...\n");
{
  const src = read("packages/dave-agent-loop/src/provider-selection.ts");
  // Compare the two handler bodies directly rather than guessing a character window.
  const keySwitch = /onKeySwitch: async[\s\S]*?\n              \},/.exec(src)![0];
  const exhausted = /onProviderExhausted: async[\s\S]*?\n              \},/.exec(src)![0];
  assert.match(keySwitch, /transientMs: TRANSIENT_NOTICE_MS/, "a key rotation that recovers must self-delete");
  assert.ok(!exhausted.includes("transientMs"), "a whole provider dropping out must STAY in the chat");
  assert.equal(TRANSIENT_NOTICE_MS, 10_000, "the trader's own number: deleted after 10 s");
  console.log(`    confirmed: key switch transient at ${TRANSIENT_NOTICE_MS}ms, provider-dead permanent`);
}

console.log("\n[9] The transient path genuinely deletes the real message it sent...\n");
{
  const deleted: { chat_id: number | string; message_id: number }[] = [];
  const client = {
    sendMessage: async () => ({ message_id: 4242 }),
    deleteMessage: async (p: { chat_id: number | string; message_id: number }) => { deleted.push(p); return true as const; },
  } as never;
  await sendSelfDeletingMessage(client, { chat_id: 5150, text: "⚠️ baseten key issue (timed out) — trying next key" }, 20);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(deleted.length, 1, "the message must genuinely be deleted");
  assert.equal(deleted[0].message_id, 4242, "…by the id sendMessage actually returned");
  assert.equal(deleted[0].chat_id, 5150);
  console.log("    confirmed: deleteMessage called with the real returned message_id");
}

console.log("\n[10] A delete that fails never takes the process down...\n");
{
  const client = {
    sendMessage: async () => ({ message_id: 7 }),
    deleteMessage: async () => { throw new Error("message to delete not found"); },
  } as never;
  await sendSelfDeletingMessage(client, { chat_id: 1, text: "x" }, 20);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(SELF_DELETE_DELAY_MS, 10_000, "the shared default matches the trader's 10s");
  console.log("    confirmed: a already-deleted / too-old message is swallowed, not thrown");
}

console.log("\n[11] All three chat-bound provider sinks honour the transient flag...\n");
{
  const server = read("packages/dave-agent-loop/src/telegram-bot-server.ts");
  const worker = read("packages/dave-agent-loop/src/worker-loop.ts");
  assert.equal((server.match(/options\?\.transientMs/g) ?? []).length, 2, "both bot-server sinks");
  assert.match(worker, /options\?\.transientMs/, "and the worker sink");
  assert.match(server, /sendSelfDeletingMessage\(client/);
  console.log("    confirmed: 2 bot-server sinks + 1 worker sink all wired");
}

console.log("\n[12] Self-improvement runs DAILY now, and each run still writes knowledge...\n");
{
  const { DEFAULT_DREAMING_CRON, DEFAULT_EXPORT_CRON } = await import("@dave/feedback");
  assert.equal(DEFAULT_DREAMING_CRON, "0 3 * * *", "daily, not Sunday-only");
  assert.equal(DEFAULT_EXPORT_CRON, "0 4 * * *", "daily, not Sunday-only");
  assert.ok(!DEFAULT_DREAMING_CRON.endsWith("0"), "a trailing 0 day-of-week would still mean weekly");
  // Each export is date-stamped, so a daily cadence writes one file per day with no collision.
  assert.match(read("packages/dave-feedback/src/weekly-export.ts"), /toISOString\(\)\.slice\(0, 10\)/);
  // And the export -> knowledge step is genuinely wired to that cron.
  assert.match(read("packages/dave-agent-loop/src/feedback-loop-handler.ts"), /reviewWeeklyExport\(/);
  console.log("    confirmed: both crons daily, files date-stamped, review still wired");
}

db.close();
console.log("\n=== ALL ASSERTIONS PASSED ===");
process.exit(0);
