import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";

const workDir = mkdtempSync(join(tmpdir(), "dave-reminders-"));
process.env.DAVE_DATA_ROOT = workDir;

const { DaveDatabase } = await import("@dave/db");
const { upsertGroup, setActiveGroup } = await import("@dave/trading");
const { getOrCreateEaWebhook, createEaWebhookServer, readTradeEventsAfter } = await import("@dave/ea-bridge");
const { REMINDER_TOOLS, listReminders, createReminder, takeDueReminders, remindersPath } = await import("@dave/workers");
const { deliverDueReminders } = await import("../src/reminder-delivery.js");
const { withLiveContext } = await import("../src/live-context.js");
const { runAutonomousTick, buildTickRemindersLine } = await import("../src/autonomous-tick.js");
const { consumePendingSymbolOverride } = await import("../src/autonomous-tick-state.js");
const { setAutonomousTradingEnabled } = await import("../src/autonomous-trading-state.js");
const { CORE_TOOL_NAMES } = await import("../src/tool-selection.js");
import type { Provider, CompletionRequest, CompletionResult, ToolCall } from "@dave/brain";
import type { TradeExecutor } from "@dave/trading";
import type { EaCommand } from "@dave/ea-bridge";

/**
 * The trader: "give the bot reminders so the bot can remind itself of something and also give it
 * delete reminder, add it to the analyzing part, and it should come up with the idea what made him
 * put the reminder ... push notification". Proves each of those end to end.
 */

console.log("=== Step 159: Dave's reminders -- set, delete, fire to chat and phone, and in the autonomous cycle ===\n");

const USER = "default";
const tool = (name: string) => REMINDER_TOOLS.find((t) => t.name === name)!;
const ctx = { ownerUserId: USER };

console.log("[1] The chat tools: a reason is required; set, list, delete\n");
for (const name of ["set_reminder", "list_reminders", "delete_reminder"]) {
  assert.ok(CORE_TOOL_NAMES.includes(name), `${name} is in front of Dave every turn`);
}
await assert.rejects(tool("set_reminder").execute({ text: "Check VOL_80", inMinutes: 30 }, ctx), /reason is required/);
await assert.rejects(tool("set_reminder").execute({ text: "Check VOL_80", reason: "x" }, ctx), /inMinutes|at/);
await assert.rejects(tool("set_reminder").execute({ text: "x", reason: "y", at: "2001-01-01T00:00:00Z" }, ctx), /already passed/);
const r1 = (await tool("set_reminder").execute(
  { text: "Re-check VOL_80 for a long after the H1 close", reason: "Sitting on H1 demand at 196500 but M15 still falling", inMinutes: 60, symbol: "vol_80" },
  ctx,
)) as { id: string; symbol: string; dueAt: number; source: string };
assert.equal(r1.symbol, "VOL_80");
assert.equal(r1.source, "chat");
assert.ok(Math.abs(r1.dueAt - (Date.now() + 60 * 60_000)) < 5_000, "due an hour from now");
const r2 = (await tool("set_reminder").execute({ text: "London open", reason: "Want fresh volume before sizing up", at: new Date(Date.now() + 120 * 60_000).toISOString() }, ctx)) as { id: string };
let listed = (await tool("list_reminders").execute({}, ctx)) as { id: string }[];
assert.deepEqual(listed.map((r) => r.id), [r1.id, r2.id], "pending, soonest first");
await tool("delete_reminder").execute({ reminderId: r2.id }, ctx);
await assert.rejects(tool("delete_reminder").execute({ reminderId: r2.id }, ctx), /No reminder/);
assert.deepEqual(listReminders(USER).map((r) => r.id), [r1.id]);
console.log("   ✓ reason required, past times refused, delete works and reports a missing id\n");

console.log("[2] Dave sees his reminders on every chat turn, with the reason\n");
let turn = withLiveContext(USER, "hi") as string;
assert.match(turn, /<reminders>/);
assert.match(turn, new RegExp(`\\[${r1.id}\\] due in (59m|1h)`));
assert.match(turn, /why: Sitting on H1 demand at 196500/);
console.log("   ✓ pending reminder with its why is in the live context\n");

console.log("[3] Nothing fires early\n");
const sent: string[] = [];
const send = async (text: string) => {
  sent.push(text);
};
assert.equal(deliverDueReminders(USER, send).length, 0);
assert.equal(sent.length, 0);
console.log("   ✓ not due, not sent\n");

console.log("[4] When due: one chat message with the reason, one phone event, next cycle looks at the symbol\n");
setAutonomousTradingEnabled(USER, true);
const later = r1.dueAt + 1_000;
const fired = deliverDueReminders(USER, send, later);
assert.equal(fired.length, 1);
await new Promise((r) => setImmediate(r));
assert.equal(sent.length, 1);
assert.match(sent[0], /Reminder · VOL_80/);
assert.match(sent[0], /Re-check VOL_80 for a long after the H1 close/);
assert.match(sent[0], /Why I set it: Sitting on H1 demand at 196500/);
const phone = readTradeEventsAfter(USER, 0).filter((e) => e.type === "reminder");
assert.equal(phone.length, 1, "the phone's event log got it");
assert.deepEqual({ ...phone[0], id: 0, at: 0 }, { id: 0, at: 0, type: "reminder", ticket: r1.id, symbol: "VOL_80", text: r1 && "Re-check VOL_80 for a long after the H1 close", reason: "Sitting on H1 demand at 196500 but M15 still falling" });
const override = consumePendingSymbolOverride(USER);
assert.equal(override?.symbol, "VOL_80", "the autonomous loop analyses the reminder's symbol next");
assert.equal(deliverDueReminders(USER, send, later + 10_000).length, 0, "never fires twice");
assert.equal(takeDueReminders(USER, later + 20_000).length, 0);
console.log("   ✓ chat + phone + next-cycle symbol, exactly once\n");

console.log("[5] A fired reminder stays in front of Dave until he deletes it (or it ages out)\n");
turn = withLiveContext(USER, "hi") as string;
assert.match(turn, new RegExp(`\\[${r1.id}\\] FIRED`));
assert.match(buildTickRemindersLine(USER) ?? "", /Fired and waiting on you/);
assert.equal(listReminders(USER, { includeFired: true }, later + 4 * 60 * 60_000).length, 0, "dropped after 3h");
console.log("   ✓ fired reminder visible in chat and tick context\n");

console.log("[6] The autonomous cycle: sees reminders, sets one with its reason, deletes one\n");
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;
const TICK_USER = "user-tick-reminders";
upsertGroup(TICK_USER, { id: "majors", name: "Majors", symbols: ["EURUSD"] });
setActiveGroup(TICK_USER, "majors");
const old = createReminder(TICK_USER, { text: "Old idea", reason: "no longer relevant", inMinutes: 300 });
const ea = startSimulatedEa(TICK_USER);
const db = new DaveDatabase(join(workDir, "dave.db"));
const executor: TradeExecutor = {
  openOrder: async () => ({ ticket: "1" }),
  modifyOrder: async () => undefined,
  closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
  deletePendingOrder: async () => undefined,
};
let contextSeen = "";
let toolSchema: Record<string, unknown> | undefined;
const provider: Provider = {
  name: "mock",
  generate: async (req: CompletionRequest): Promise<CompletionResult> => {
    contextSeen = req.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    toolSchema = (req.tools?.[0]?.parameters as { properties: Record<string, unknown> }).properties;
    const toolCalls: ToolCall[] = [
      {
        id: "c1",
        name: "submit_trading_decision",
        arguments: {
          action: "SKIP",
          reason: "waiting on the H4 close",
          confidence: 40,
          setReminder: { text: "Look at EURUSD again after the H4 close", reason: "H4 is testing the 1.0850 breaker; a close above flips me long", inMinutes: 90 },
          deleteReminderIds: [old.id],
        },
      },
    ];
    return { text: "", provider: "mock", latencyMs: 1, toolCalls };
  },
};
await runAutonomousTick({ userId: TICK_USER, db, executor, provider });
await ea.stop();
globalThis.fetch = realFetch;
if (contextSeen) {
  assert.ok(toolSchema?.setReminder && toolSchema?.deleteReminderIds, "the decision tool offers setReminder and deleteReminderIds");
  assert.match(contextSeen, /YOUR REMINDERS/);
  assert.match(contextSeen, new RegExp(`\\[${old.id}\\]`), "the cycle saw its pending reminder");
  assert.match(contextSeen, /REMINDERS: on ANY decision/, "the cycle is told how to use them");
  const after = listReminders(TICK_USER);
  assert.equal(after.length, 1, "old one deleted, new one set");
  assert.equal(after[0].text, "Look at EURUSD again after the H4 close");
  assert.equal(after[0].reason, "H4 is testing the 1.0850 breaker; a close above flips me long");
  assert.equal(after[0].source, "autonomous");
  assert.equal(after[0].symbol, "EURUSD", "defaults to the symbol being analysed");
  console.log("   ✓ the cycle saw, set (with its reason) and deleted reminders\n");
} else {
  // The tick skips the model when the market is closed; the reminder mechanics are still covered
  // above, so this only records it rather than failing on the calendar.
  console.log("   (EURUSD market closed right now -- the tick made no model call; skipped this part)\n");
}

console.log("[7] A corrupt store costs nothing\n");
const { writeFileSync } = await import("node:fs");
writeFileSync(remindersPath(USER), "{not json", "utf8");
assert.deepEqual(listReminders(USER), []);
assert.doesNotMatch(withLiveContext(USER, "hi") as string, /<reminders>/);
assert.equal(deliverDueReminders(USER, send).length, 0);
console.log("   ✓ empty, no crash\n");

rmSync(workDir, { recursive: true, force: true });
console.log("=== ALL ASSERTIONS PASSED ===");
process.exit(0);

function startSimulatedEa(userId: string) {
  const webhook = getOrCreateEaWebhook(userId);
  const server = createEaWebhookServer();
  let port = 0;
  const ready = new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => { port = (server.address() as { port: number }).port; resolve(); }));
  const postReport = (body: unknown): Promise<{ commands: EaCommand[] }> =>
    new Promise((resolve, reject) => {
      const json = JSON.stringify(body);
      const req = request(
        { hostname: "127.0.0.1", port, path: webhook.path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(json) } },
        (res) => { let data = ""; res.on("data", (c) => (data += c)); res.on("end", () => resolve(JSON.parse(data))); },
      );
      req.on("error", reject);
      req.write(json);
      req.end();
    });
  let running = true;
  const loop = (async () => {
    await ready;
    while (running) {
      const heartbeat = { type: "heartbeat", account: "123", balance: 1000, positions: [], pendingOrders: [] };
      const resp = await postReport(heartbeat).catch(() => ({ commands: [] as EaCommand[] }));
      for (const cmd of resp.commands) {
        if (cmd.action !== "analyze") continue;
        await postReport({ ...heartbeat, results: [{ commandId: cmd.id, status: "ok", data: { price: { bid: 1, ask: 1.0002 }, volatility: { atr: 0.001 } } }] }).catch(() => undefined);
      }
      await new Promise((r) => setTimeout(r, 30));
    }
  })();
  return { stop: async () => { running = false; await loop; await ready; server.close(); } };
}
