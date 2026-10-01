import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "dave-nous-flow-"));
process.env.DAVE_DATA_ROOT = root;
process.env.DAVE_CREDENTIALS_KEY ??= "test-only-master-key-not-for-production";

/**
 * The trader's gold channel, post by post (fake MT5, fake model):
 *   "GOLD BUY NOW"                          -> not a trade on its own (no stop): nothing placed
 *   "GOLD BUY NOW IN ZONE 4155.50-4148.50 ... TP 1 4157.50 TP 2 4159.50 TP 3 OPEN SL 4145.50"
 *                                           -> placed: SL 4145.5, no broker TP (TP3 open), targets noted
 *   "HIT TP 1 ✅ +50 PIPS ... set BE"         -> stop to breakeven, no card, no tap
 *   "HIT TP 2"                              -> stop to TP1
 *   the provider's reason                   -> saved to Dave's knowledge
 */
const { normalizeSignal, worthReading } = await import("../src/nous/parse.js");
const { planPlacement } = await import("../src/nous/plan.js");
const { advanceNousTrade } = await import("../src/nous/manager.js");
const { onNousPost, manageNousTrades } = await import("../src/nous/service.js");
const store = await import("../src/nous/store.js");
const { recordActiveChat } = await import("../src/primary-chat.js");
const { DaveDatabase } = await import("@dave/db");
const { knowledgeList } = await import("@dave/knowledge");

const MIN = 60_000;
const now = Date.parse("2026-10-01T10:00:00Z");
console.log("=== Step 199: copy trading -- the channel's post-by-post flow ===\n");

const levels = { kind: "signal", symbol: "GOLD", side: "buy", orderKind: "market", entryLow: 4155.5, entryHigh: 4148.5, tp1: 4157.5, tp2: 4159.5, tpOpen: true, sl: 4145.5, reason: "" };

console.log("[1] Reading: the zone, TP3 OPEN, and a bare 'BUY NOW' is not a trade");
const s = normalizeSignal(levels)!;
assert.deepEqual(s.zone, [4148.5, 4155.5]);
assert.equal(s.tpOpen, true);
assert.equal(s.tp2, 4159.5);
assert.equal(normalizeSignal({ kind: "signal", symbol: "GOLD", side: "buy" }), undefined, "no stop -> never a trade");
assert.ok(!worthReading("GOLD BUY NOW", false, false), "nothing open: a bare call costs no model call");
assert.ok(worthReading("HIT TP 1 ✅ +50 PIPS", false, true), "a trade from this channel is open: every post is read");
assert.ok(worthReading("I took this because of the H1 order block", false, true));
console.log("   ✓\n");

console.log("[2] Price at the top of their zone is still their entry");
const p = planPlacement(s, 4155.2, now, now, 10);
assert.ok(p.ok && p.type === "buy", "inside the zone -> market");
assert.ok(!planPlacement({ ...s, zone: undefined }, 4155.2, now, now, 10).ok, "without the zone it would have read as 'entry passed'");
console.log("   ✓\n");

// ---- The service, with a fake MT5 and a fake Telegram ----
const db = new DaveDatabase(join(root, "dave.db"));
const userId = "trader";
recordActiveChat(db, userId, 777);
store.updateNousConfig(userId, { autoApprove: true });
const sentText: string[] = [];
const sentRich: unknown[] = [];
const client = {
  sendRichMessage: async (m: { rich_message: unknown }) => (sentRich.push(m.rich_message), { message_id: 100 + sentRich.length }),
  sendMessage: async (m: { text: string }) => (sentText.push(m.text), { message_id: 500 + sentText.length }),
  editMessageReplyMarkup: async () => ({ message_id: 0 }),
} as never;
const orders: { symbol: string; type: string; sl?: number; tp?: number }[] = [];
const modifies: [string, { sl?: number | null; tp?: number | null }][] = [];
const executor = {
  openOrder: async (o: never) => (orders.push(o), { ticket: "8001" }),
  modifyOrder: async (t: string, c: never) => void modifies.push([t, c]),
  closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
  deletePendingOrder: async () => undefined,
  listOpenPositions: async () => [],
  listPendingOrders: async () => [],
};
const script: Record<string, unknown>[] = [];
let calls = 0;
const provider = {
  name: "fake",
  generate: async () => {
    calls++;
    const next = script.shift() ?? { kind: "none" };
    return { text: "", provider: "fake", latencyMs: 1, toolCalls: [{ id: String(calls), name: "report_post", arguments: next }] };
  },
} as never;
let price = 4154;
let positions: { ticket: string; symbol: string; type: "buy"; lots: number; openPrice: number; currentPrice?: number; sl?: number; pnl?: number; spread?: number; digits?: number }[] = [];
const deps = {
  userId,
  db,
  client,
  executor,
  provider: () => provider,
  quote: async () => price,
  eaState: () => ({ positions, pendingOrders: [] }),
  account: () => ({ account: "1", balance: 1000, equity: 1000, margin: 10, freeMargin: 990, updatedAt: 0 }),
  consult: async () => "HOLD",
};
const post = (id: number, text: string) => ({ chatId: "-1009", chatTitle: "Gold Scalpers", messageId: id, postedAt: now, text });

console.log("[3] 'GOLD BUY NOW' alone -> nothing placed");
await onNousPost(deps as never, post(1, "GOLD BUY NOW"), now);
assert.equal(orders.length, 0);
console.log("   ✓\n");

console.log("[4] The levels post -> placed with SL 4145.5 and no broker TP (TP3 open)");
script.push(levels);
await onNousPost(deps as never, post(2, "GOLD BUY NOW IN ZONE  4155.50-4148.50\n(SCALPING)\n\nTP 1 : 4157.50\nTP 2 : 4159.50\nTP 3 : OPEN\n\nSL :  4145.50"), now);
assert.deepEqual(orders.map((o) => [o.symbol, o.type, o.sl, o.tp]), [["XAUUSD", "buy", 4145.5, undefined]]);
const trade = store.listNousTrades(userId)[0];
assert.deepEqual(trade.tps, [4157.5, 4159.5]);
assert.equal(trade.tpOpen, true);
console.log("   ✓\n");

console.log("[5] 'HIT TP 1 ✅ +50 PIPS ... set BE' -> stop to breakeven at once, no card");
positions = [{ ticket: "8001", symbol: "XAUUSD", type: "buy", lots: 0.01, openPrice: 4154, currentPrice: 4157.6, sl: 4145.5, pnl: 3.6, spread: 0.3, digits: 2 }];
store.saveNousTrades(userId, store.listNousTrades(userId).map((t) => ({ ...t, filled: true })));
script.push({ kind: "update", action: "tp_hit", tpNumber: 1 });
await onNousPost(deps as never, post(3, "HIT TP 1 ✅ +50 PIPS\n\nScalper trader can close now. Who wanna hold do set BE for 0% risk."), now + 2 * MIN);
assert.equal(modifies.length, 1);
const be = modifies[0][1].sl!;
assert.ok(be > 4154 && be < 4155, `breakeven is entry + spread (${be})`);
assert.equal(modifies[0][1].tp, undefined, "the target is left alone");
assert.ok(sentText.some((t) => /TP1 hit/.test(t) && /stop moved to breakeven/.test(t)), sentText.at(-1));
console.log("   ✓\n");

console.log("[6] The manager sees TP1 already handled -- no second move");
positions[0].sl = be;
await manageNousTrades(deps as never, now + 3 * MIN);
assert.equal(modifies.length, 1);
console.log("   ✓\n");

console.log("[7] 'HIT TP 2' -> stop to TP1 (4157.5)");
positions[0].currentPrice = 4159.7;
script.push({ kind: "update", action: "tp_hit", tpNumber: 2 });
await onNousPost(deps as never, post(4, "HIT TP 2 ✅ +70 PIPS"), now + 5 * MIN);
assert.deepEqual(modifies[1], ["8001", { sl: 4157.5 }]);
script.push({ kind: "update", action: "tp_hit", tpNumber: 2 });
await onNousPost(deps as never, post(5, "TP2 done again ✅"), now + 6 * MIN);
assert.equal(modifies.length, 2, "the same TP twice moves nothing");
console.log("   ✓\n");

console.log("[8] The provider's reason -> Dave's knowledge; chatter -> nothing");
script.push({ kind: "note", reason: "Took it from the H1 demand zone after the Asian low was swept." });
await onNousPost(deps as never, post(6, "Why we bought: H1 demand zone after the Asian low sweep"), now + 7 * MIN);
assert.ok(knowledgeList(userId).some((e) => /Asian low was swept/.test(e.content) && /4157.5/.test(e.content)));
const before = sentText.length;
await onNousPost(deps as never, post(7, "Good morning family 🌞"), now + 8 * MIN);
assert.equal(sentText.length, before, "a random message is read and skipped");
console.log("   ✓\n");

console.log("[9] By price alone (no post): a TP reached trails the stop one step");
const t = { ...trade, tpHits: 0, sl: 4145.5 };
let a = advanceNousTrade(t, { openPrice: 4154, currentPrice: 4157.6, pnl: 3 }, undefined, now);
assert.deepEqual(a, [{ kind: "trail", tpNumber: 1, sl: undefined }], "TP1 -> breakeven");
a = advanceNousTrade(t, { openPrice: 4154, currentPrice: 4158, pnl: 4 }, undefined, now);
assert.deepEqual(a, [], "between TP1 and TP2 -- nothing");
a = advanceNousTrade(t, { openPrice: 4154, currentPrice: 4159.5, pnl: 5 }, undefined, now);
assert.deepEqual(a, [{ kind: "trail", tpNumber: 2, sl: 4157.5 }], "TP2 -> stop to TP1");
console.log("   ✓\n");

console.log("=== ALL ASSERTIONS PASSED ===");
process.exit(0);
