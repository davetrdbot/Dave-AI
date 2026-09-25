import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "dave-app-chat-"));
process.env.DAVE_DATA_ROOT = root;
process.env.DAVE_CREDENTIALS_KEY ??= "test-only-master-key-not-for-production";

/**
 * Chat with Dave in the app: a message in, every step live (tool start/end, text, thinking), the
 * reply out -- in the same conversation as Telegram -- served by the bot with the paired-device token.
 */
const { AgentLoop } = await import("../src/agent-loop.js");
const { ToolRegistry } = await import("../src/tool-registry.js");
const bus = await import("../src/activity-bus.js");
const { runAppChatTurn, createAppSink, sharedHistoryKey } = await import("../src/app-chat.js");
const { createAppChatHandler, historyForDisplay } = await import("../src/app-chat-routes.js");
const { beginTurn, endTurn, abortTurn } = await import("../src/turn-abort.js");
const { recordActiveChat } = await import("../src/primary-chat.js");
const { loadConversationHistory } = await import("../src/conversation-store.js");
const { getBusyState } = await import("../src/busy-state.js");
const { DaveDatabase, hashDeviceToken } = await import("@dave/db");

console.log("=== Step 168: chat with Dave in the app ===\n");
const userId = "owner";

console.log("[1] The activity bus: ids only go up, events persist and come back after a restart");
const a = bus.publishActivity(userId, "loop", "cycle_start", { symbols: ["XAUUSD"] });
const b = bus.publishActivity(userId, "chat", "text", { text: "x".repeat(10_000) });
assert.equal(b.id, a.id + 1);
assert.ok(String(b.data.text).length < 4100, "long fields are clipped");
bus.resetActivityBusForTests();
assert.deepEqual(bus.activityAfter(userId, 0).map((e) => e.id), [a.id, b.id], "reloaded from the file");
assert.deepEqual(bus.activityAfter(userId, 0, ["loop"]).map((e) => e.kind), ["cycle_start"]);
console.log("   ✓\n");

console.log("[2] The core loop reports each step live: text, thinking, tool start/end");
const registry = new ToolRegistry().register([
  { name: "get_account_balance", description: "balance", parameters: { type: "object" }, execute: async () => ({ balance: 1000 }) },
  { name: "tg_rich_blocks", description: "rich", parameters: { type: "object" }, execute: async () => ({ ok: true }) },
]);
let call = 0;
const provider = {
  name: "fake",
  generate: async () =>
    ++call % 2 === 1
      ? { text: "Let me check.", reasoning: "Need the balance first.", provider: "fake", latencyMs: 1, toolCalls: [{ id: "c1", name: "get_account_balance", arguments: {} }] }
      : { text: "You have $1000.", provider: "fake", latencyMs: 1 },
} as never;
const events: string[] = [];
const run = await new AgentLoop(provider, registry).run([{ role: "user", content: "balance?" }], { onEvent: (e) => events.push(e.type) });
assert.equal(run.status, "done");
assert.deepEqual(events, ["thinking", "text", "tool_start", "tool_end"]);
console.log("   ✓\n");

console.log("[3] An app turn: same conversation as Telegram, every step on the bus, busy cleared after");
const db = new DaveDatabase(join(root, "dave.db"));
recordActiveChat(db, userId, 555);
assert.equal(sharedHistoryKey(db, userId), `${userId}:555`, "the Telegram chat's conversation");
const deps = { userId, db, executor: {} as never, systemPrompt: "You are Dave." };
const before = bus.latestActivityId(userId);
call = 0;
const result = await runAppChatTurn(deps, { text: "what's my balance?" }, "turn1", () => new AgentLoop(provider, registry));
assert.equal(result?.status, "done");
const kinds = bus.activityAfter(userId, before).filter((e) => e.turnId === "turn1").map((e) => e.kind);
assert.deepEqual(kinds, ["user_message", "turn_start", "thinking", "text", "tool_start", "tool_end", "final"]);
const final = bus.activityAfter(userId, before).find((e) => e.kind === "final")!;
assert.equal(final.data.text, "You have $1000.");
assert.equal(final.channel, "app");
const stored = loadConversationHistory(db, `${userId}:555`);
assert.ok(stored.some((m) => m.role === "user" && String(m.content).includes("what's my balance?")), "saved in the shared conversation");
assert.equal(getBusyState(userId), null);
console.log("   ✓\n");

console.log("[4] Tools that would message Telegram post into the app chat instead");
const sink = createAppSink(userId, () => ({ turnId: "t2", channel: "app" }));
const sent = await sink.sendRichMessage({ chat_id: 0, rich_message: { blocks: [{ type: "table", cells: [["a", "b"]] }] } });
assert.ok(sent.message_id > 0);
const msg = bus.activityAfter(userId, 0).at(-1)!;
assert.equal(msg.kind, "message");
assert.deepEqual((msg.data.blocks as unknown[])[0], { type: "table", cells: [["a", "b"]] });
await assert.rejects(() => sink.getMe(), /works in Telegram only/);
console.log("   ✓\n");

console.log("[5] A Telegram message doesn't kill an app reply mid-way; /stop stops everything");
const appTurn = beginTurn(userId, "app");
const tick = beginTurn(userId, "background");
abortTurn(userId, { except: "app" });
assert.ok(!appTurn.signal.aborted && tick.signal.aborted);
abortTurn(userId);
assert.ok(appTurn.signal.aborted);
endTurn(userId, appTurn);
endTurn(userId, tick);
console.log("   ✓\n");

console.log("[6] History for display: tool steps and the answer read as one Dave message");
const shown = historyForDisplay([
  { role: "system", content: "sys" },
  { role: "user", content: "hi" },
  { role: "assistant", content: "Checking.", toolCalls: [{ id: "1", name: "get_price", arguments: {} }] },
  { role: "tool", toolCallId: "1", content: "{}" },
  { role: "assistant", content: "Gold is 2350." },
]);
assert.deepEqual(shown, [
  { role: "user", text: "hi" },
  { role: "assistant", text: "Checking.\n\nGold is 2350.", tools: [{ name: "get_price" }] },
]);
console.log("   ✓\n");

console.log("[7] The routes: the paired-device token, send, busy, stream");
const token = "phone-token-123";
const statePath = join(root, "data", "device-auth", userId, "state.json");
mkdirSync(join(root, "data", "device-auth", userId), { recursive: true });
writeFileSync(statePath, JSON.stringify({ devices: [{ id: "d1", tokenHash: hashDeviceToken(token), label: "phone", pairedAt: 1 }] }));
const turns: string[] = [];
const handler = createAppChatHandler({ ...deps, runTurn: async (_d, input) => (turns.push(input.text), undefined) });
const server = createServer(handler);
await new Promise<void>((r) => server.listen(0, r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/app/chat`;
const H = { authorization: `Bearer ${token}`, "content-type": "application/json" };
assert.equal((await fetch(`${base}/history`)).status, 401, "no token");
assert.equal((await fetch(`${base}/history`, { headers: { authorization: "Bearer wrong" } })).status, 401, "bad token");
const hist = (await (await fetch(`${base}/history`, { headers: H })).json()) as { items: { text: string }[] };
assert.ok(hist.items.some((i) => i.text.includes("what's my balance?")));
const ok = await fetch(`${base}/send`, { method: "POST", headers: H, body: JSON.stringify({ text: "hello" }) });
assert.equal(ok.status, 202);
await new Promise((r) => setTimeout(r, 20));
assert.deepEqual(turns, ["hello"]);
assert.equal((await fetch(`${base}/send`, { method: "POST", headers: H, body: "{}" })).status, 400, "empty message");
// Busy: another turn is running
const { setBusy, clearBusy } = await import("../src/busy-state.js");
setBusy(userId, "analysing gold");
const busy = await fetch(`${base}/send`, { method: "POST", headers: H, body: JSON.stringify({ text: "again" }) });
assert.equal(busy.status, 409);
assert.equal(((await busy.json()) as { task: string }).task, "analysing gold");
clearBusy(userId);
// Stream: replays after ?after= and then delivers live
const streamRes = await fetch(`${base}/stream?after=${bus.latestActivityId(userId)}`, { headers: H });
assert.equal(streamRes.headers.get("content-type"), "text/event-stream");
const reader = streamRes.body!.getReader();
bus.publishActivity(userId, "loop", "decision", { action: "BUY", symbol: "XAUUSD" });
let got = "";
for (let i = 0; i < 5 && !got.includes("decision"); i++) got += new TextDecoder().decode((await reader.read()).value);
assert.match(got, /event: activity\ndata: .*"kind":"decision"/);
await reader.cancel();
server.close();
assert.ok(existsSync(statePath));
console.log("   ✓\n");

console.log("=== ALL ASSERTIONS PASSED ===");
process.exit(0);
