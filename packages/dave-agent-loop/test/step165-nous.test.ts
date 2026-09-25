import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "dave-nous-"));
process.env.DAVE_DATA_ROOT = root;
process.env.DAVE_CREDENTIALS_KEY ??= "test-only-master-key-not-for-production";

/**
 * Nous -- copy trading from the trader's signal channels, with their permission:
 *   read a new signal -> skip it if old or the entry has passed -> ask Yes/No (or auto-approve)
 *   -> place with TP = TP1 -> save the reason to Dave's knowledge -> at TP1 move the stop to entry
 *   and go for TP2 -> losing 5 min / margin stretched -> ask Dave if it's still valid.
 */
const { normalizeSignal, looksLikeSignal, parseSignal } = await import("../src/nous/parse.js");
const { planPlacement } = await import("../src/nous/plan.js");
const { advanceNousTrade, marginStretched } = await import("../src/nous/manager.js");
const { onNousPost, placeNousSignal, skipNousSignal, manageNousTrades } = await import("../src/nous/service.js");
const store = await import("../src/nous/store.js");
const { recordActiveChat } = await import("../src/primary-chat.js");
const { DaveDatabase } = await import("@dave/db");
const { knowledgeList } = await import("@dave/knowledge");

const MIN = 60_000;
console.log("=== Step 165: Nous copy trading ===\n");

console.log("[1] Reading a signal: real levels on the right sides, or nothing");
const gold = { isSignal: true, symbol: "gold", side: "buy", orderKind: "market", entryLow: 2346, entryHigh: 2350, sl: 2340, tp1: 2356, tp2: 2365, reason: "Bullish OB on H1 after a liquidity sweep" };
let s = normalizeSignal({ ...gold, symbol: "XAU/USD" })!;
assert.equal(s.symbol, "XAUUSD");
assert.equal(s.entry, 2348, "a range becomes its midpoint");
assert.equal(s.tp2, 2365);
assert.equal(normalizeSignal({ ...gold, isSignal: false }), undefined, "'TP1 hit' style posts are not signals");
assert.equal(normalizeSignal({ ...gold, sl: 2360 }), undefined, "a buy with its stop above TP1 is nonsense");
assert.equal(normalizeSignal({ ...gold, tp2: 2350 })!.tp2, undefined, "TP2 short of TP1 is dropped");
assert.equal(normalizeSignal({ ...gold, entryLow: undefined, entryHigh: undefined, orderKind: "limit" })!.orderKind, "market", "no price -> market");
assert.ok(looksLikeSignal("GOLD BUY NOW 2350 SL 2340 TP 2356"));
assert.ok(!looksLikeSignal("TP1 hit guys 🔥🔥"));
console.log("   ✓\n");

console.log("[2] Time conscious: old signals and passed entries are never placed");
const now = Date.parse("2026-09-25T10:00:00Z");
const buy = normalizeSignal(gold)!; // entry 2348, SL 2340, TP1 2356
let p = planPlacement(buy, 2348.5, now - 25 * MIN, now, 10);
assert.ok(!p.ok && /25 min ago/.test(p.reason), "posted 25 min ago, limit 10");
p = planPlacement(buy, 2339, now, now, 10);
assert.ok(!p.ok && /past the stop/.test(p.reason));
p = planPlacement(buy, 2357, now, now, 10);
assert.ok(!p.ok && /reached TP1/.test(p.reason));
p = planPlacement(buy, 2352, now, now, 10);
assert.ok(!p.ok && /entry passed -- .* 50% of the way/.test(p.reason), "already half way to TP1");
p = planPlacement(buy, 2349, now - 2 * MIN, now, 10);
assert.ok(p.ok && p.type === "buy", "12% of the way is still takeable at market");
const limit = { ...buy, orderKind: "limit" as const, entry: 2344 };
p = planPlacement(limit, 2349, now, now, 10);
assert.ok(p.ok && p.type === "buy_limit" && p.price === 2344, "a buy limit below price stays a limit");
p = planPlacement(limit, 2343.5, now, now, 10);
assert.ok(p.ok && p.type === "buy", "the limit level already reached -> market");
const sellStop = normalizeSignal({ isSignal: true, symbol: "EURUSD", side: "sell", orderKind: "stop", entryLow: 1.08, sl: 1.085, tp1: 1.07 })!;
p = planPlacement(sellStop, 1.0812, now, now, 10);
assert.ok(p.ok && p.type === "sell_stop");
console.log("   ✓\n");

console.log("[3] The model is only asked when a post looks like a signal, and forced through one tool");
let calls = 0;
/** What the fake model answers next: a queue, else "it's the gold signal". */
const script: Record<string, unknown>[][] = [];
const seen: { messages: { role: string; content: unknown }[]; tools?: { name: string }[] }[] = [];
const provider = {
  name: "fake",
  generate: async (req: { messages: { role: string; content: unknown }[]; tools?: { name: string }[] }) => {
    calls++;
    seen.push(req);
    const next = script.shift() ?? [{ id: "1", name: "report_post", arguments: { ...gold, kind: "signal" } }];
    return { text: "", provider: "fake", latencyMs: 1, toolCalls: next };
  },
} as never;
assert.equal(await parseSignal(provider, "gm traders, big week ahead"), undefined);
assert.equal(calls, 0);
assert.equal((await parseSignal(provider, "XAUUSD BUY 2346-2350 SL 2340 TP1 2356 TP2 2365"))?.symbol, "XAUUSD");
console.log("   ✓\n");

// ---- The whole flow, through the service, with a fake MT5 and a fake Telegram ----
const db = new DaveDatabase(join(root, "dave.db"));
const userId = "trader";
recordActiveChat(db, userId, 777);
const sentRich: { blocks: { type: string; text?: string; cells?: string[][] }[]; reply_markup?: { inline_keyboard: { callback_data: string }[][] } }[] = [];
const sentText: string[] = [];
const client = {
  sendRichMessage: async (m: { rich_message: { blocks: never[] }; reply_markup?: never }) => (sentRich.push({ blocks: m.rich_message.blocks, reply_markup: m.reply_markup }), { message_id: 100 + sentRich.length }),
  sendMessage: async (m: { text: string }) => (sentText.push(m.text), { message_id: 500 + sentText.length }),
  editMessageReplyMarkup: async () => ({ message_id: 0 }),
} as never;
const closes: [string, number | undefined][] = [];
const cancels: string[] = [];
const orders: { symbol: string; type: string; lots: number; sl?: number; tp?: number; price?: number }[] = [];
const modifies: [string, { sl?: number | null; tp?: number | null }][] = [];
const executor = {
  openOrder: async (o: never) => (orders.push(o), { ticket: "9001" }),
  modifyOrder: async (t: string, c: never) => void modifies.push([t, c]),
  closePosition: async (t: string, lots?: number) => (closes.push([t, lots]), { closedLots: lots ?? 0, remainingLots: 0 }),
  deletePendingOrder: async (t: string) => void cancels.push(t),
  listOpenPositions: async () => [],
  listPendingOrders: async () => [],
};
let price = 2348.5;
let positions: { ticket: string; symbol: string; type: "buy"; lots: number; openPrice: number; currentPrice?: number; pnl?: number }[] = [];
const consulted: string[] = [];
const deps = {
  userId,
  db,
  client,
  executor,
  provider: () => provider,
  quote: async () => price,
  eaState: () => ({ positions, pendingOrders: [] }),
  account: () => ({ account: "1", balance: 1000, equity: 990, margin: 50, freeMargin: 940, updatedAt: 0 }),
  consult: async (q: string) => (consulted.push(q), "Structure still holds above the sweep low.\nHOLD"),
};
const post = { chatId: "-1001", chatTitle: "Gold VIP", messageId: 1, postedAt: now - 1 * MIN, text: "XAUUSD BUY 2346-2350 SL 2340 TP1 2356 TP2 2365 -- bullish OB after sweep" };

console.log("[4] A fresh signal -> a table card with Place / Skip (auto-approve off)");
await onNousPost(deps as never, post, now);
assert.equal(orders.length, 0, "nothing placed without the trader's yes");
const card = sentRich.at(-1)!;
const table = card.blocks.find((b) => b.type === "table")!;
assert.ok(table.cells!.some((r) => r[0] === "TP1 (target)" && r[1] === "2356"));
const buttons = card.reply_markup!.inline_keyboard[0].map((b) => b.callback_data);
assert.ok(buttons[0].startsWith("nous:y:") && buttons[1].startsWith("nous:n:"));
const signalId = buttons[0].split(":")[2];
await onNousPost(deps as never, post, now);
assert.equal(sentRich.length, 1, "the same post twice is one signal");
console.log("   ✓\n");

console.log("[5] Yes -> re-checked at the live price, placed with TP = TP1, reason saved to Dave's knowledge");
await placeNousSignal(deps as never, signalId, now + 1 * MIN);
assert.deepEqual(orders.map((o) => [o.symbol, o.type, o.sl, o.tp]), [["XAUUSD", "buy", 2340, 2356]]);
assert.equal(store.getNousSignal(userId, signalId)?.status, "placed");
const k = knowledgeList(userId).find((e) => /Signal setup: XAUUSD buy/.test(e.title))!;
assert.ok(k && /bullish OB/i.test(k.content) || /OB/.test(k.content), "the provider's reason is in knowledge");
assert.equal(await placeNousSignal(deps as never, signalId, now + 2 * MIN), "Already placed.", "a second tap does nothing");
console.log("   ✓\n");

console.log("[6] Near TP1 -> stop to entry, target to TP2 (once)");
positions = [{ ticket: "9001", symbol: "XAUUSD", type: "buy", lots: 0.01, openPrice: 2348.5, currentPrice: 2350, pnl: 1.5 }];
await manageNousTrades(deps as never, now + 3 * MIN);
assert.equal(modifies.length, 0, "only 20% of the way -- nothing yet");
positions[0].currentPrice = 2355.4; // 0.92 of the way from 2348.5 to 2356
await manageNousTrades(deps as never, now + 4 * MIN);
assert.deepEqual(modifies, [["9001", { sl: 2348.5, tp: 2365 }]]);
await manageNousTrades(deps as never, now + 5 * MIN);
assert.equal(modifies.length, 1, "moved once");
assert.ok(sentText.some((t) => /reached TP1 -- stop moved to entry \(2348.5\), now riding to TP2 \(2365\)/.test(t)));
console.log("   ✓\n");

console.log("[7] Position gone -> result appended to the knowledge entry");
positions = [];
await manageNousTrades(deps as never, now + 6 * MIN);
assert.equal(store.listNousTrades(userId).length, 0);
assert.ok(knowledgeList(userId).some((e) => /Result: reached TP1 and was moved to breakeven/.test(e.content)));
console.log("   ✓\n");

console.log("[8] Losing for 5 minutes -> Dave is asked whether it's still valid, with Close / Keep");
const t = { ticket: "1", signalId: "x", symbol: "XAUUSD", side: "buy" as const, lots: 0.01, entry: 2348, sl: 2340, tp1: 2356, tp2: 2365, reason: "", chatTitle: "c", placedAt: now, stage: "tp1" as const };
const losingPos = { openPrice: 2348, currentPrice: 2346, pnl: -2 };
const calm = { balance: 1000, equity: 998, margin: 20, freeMargin: 978 };
assert.deepEqual(advanceNousTrade(t, losingPos, calm, now), [], "just started losing");
assert.deepEqual(advanceNousTrade(t, losingPos, calm, now + 4 * MIN), []);
assert.equal(advanceNousTrade(t, losingPos, calm, now + 5 * MIN)[0]?.kind, "askValidity");
assert.deepEqual(advanceNousTrade(t, losingPos, calm, now + 10 * MIN), [], "not re-asked within 30 min");
assert.equal(advanceNousTrade(t, losingPos, calm, now + 36 * MIN)[0]?.kind, "askValidity");
const t2 = { ...t, losingSince: undefined, validityAskedAt: undefined };
assert.ok(marginStretched({ balance: 1000, equity: 500, margin: 400, freeMargin: 100 }));
assert.equal(advanceNousTrade(t2, losingPos, { balance: 1000, equity: 500, margin: 400, freeMargin: 100 }, now)[0]?.kind, "askValidity", "eating margin -> ask right away");

store.saveNousTrades(userId, [{ ...t, ticket: "9002", placedAt: now, filled: true, losingSince: undefined, validityAskedAt: undefined }]);
positions = [{ ticket: "9002", symbol: "XAUUSD", type: "buy", lots: 0.01, openPrice: 2348, currentPrice: 2346, pnl: -2 }];
await manageNousTrades(deps as never, now + 1 * MIN);
await manageNousTrades(deps as never, now + 7 * MIN);
await new Promise((r) => setTimeout(r, 20));
assert.equal(consulted.length, 1);
const ask = sentRich.at(-1)!;
assert.ok(ask.blocks.some((b) => b.type === "paragraph" && /Structure still holds/.test(b.text!)));
assert.deepEqual(ask.reply_markup!.inline_keyboard[0].map((b) => b.callback_data), ["nous:c:9002", "nous:k:9002"]);
console.log("   ✓\n");

console.log("[9] Skip, auto-approve, and an entry that passed while the card waited");
store.saveNousTrades(userId, []);
await onNousPost(deps as never, { ...post, messageId: 2 }, now);
const id2 = sentRich.at(-1)!.reply_markup!.inline_keyboard[0][0].callback_data.split(":")[2];
await skipNousSignal(deps as never, id2);
assert.equal(store.getNousSignal(userId, id2)?.status, "skipped");
await onNousPost(deps as never, { ...post, messageId: 3 }, now);
const id3 = sentRich.at(-1)!.reply_markup!.inline_keyboard[0][0].callback_data.split(":")[2];
price = 2353; // ran away while the trader was deciding
const before = orders.length;
await placeNousSignal(deps as never, id3, now + 3 * MIN);
assert.equal(orders.length, before);
assert.ok(sentText.at(-1)!.includes("entry passed"));
price = 2348.5;
store.updateNousConfig(userId, { autoApprove: true, lots: 0.05 });
await onNousPost(deps as never, { ...post, messageId: 4 }, now);
assert.equal(orders.length, before + 1, "auto-approve places it straight away");
assert.equal(orders.at(-1)!.lots, 0.05);
await onNousPost(deps as never, { ...post, messageId: 5, postedAt: now - 2 * 24 * 60 * MIN }, now);
assert.equal(orders.length, before + 1, "a two-day-old post is ignored even on auto-approve");
console.log("   ✓\n");

console.log("[10] get_price: Nous looks up the live price itself, e.g. to turn pips into prices");
store.updateNousConfig(userId, { autoApprove: false });
seen.length = 0;
script.push(
  [{ id: "p1", name: "get_price", arguments: { symbol: "gold" } }],
  [{ id: "r1", name: "report_post", arguments: { kind: "signal", symbol: "XAUUSD", side: "buy", orderKind: "market", sl: 2345.5, tp1: 2351.5, reason: "30 pips SL, 30 pips TP from market" } }],
);
await onNousPost(deps as never, { ...post, messageId: 10, text: "GOLD BUY NOW SL 30 pips TP 30 pips" }, now);
assert.ok(seen[0].tools!.some((t) => t.name === "get_price"), "get_price is offered");
const toolAnswer = seen[1].messages.find((m) => m.role === "tool")!;
assert.match(String(toolAnswer.content), /"symbol":"XAUUSD".*"bid":2348.5/, "the model got the live price back (GOLD -> XAUUSD)");
const pipCard = sentRich.at(-1)!.blocks.find((b) => b.type === "table")!;
assert.ok(pipCard.cells!.some((r) => r[0] === "Stop loss" && r[1] === "2345.5"));
console.log("   ✓\n");

console.log("[11] A picture signal: the screenshot goes to the model");
seen.length = 0;
const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
await onNousPost(deps as never, { ...post, messageId: 11, text: "", image: png }, now);
const content = seen[0].messages.find((m) => m.role === "user")!.content as { type: string }[];
assert.ok(content.some((c) => c.type === "image"), "the image is in the request");
console.log("   ✓\n");

console.log("[12] Follow-ups from the provider: close / breakeven / cancel, with your permission");
store.saveNousTrades(userId, [
  { ...t, ticket: "7001", chatId: "-1001", messageId: 50, placedAt: now - 10 * MIN, filled: true, losingSince: undefined, validityAskedAt: undefined },
  { ...t, ticket: "7002", symbol: "EURUSD", chatId: "-1001", messageId: 51, placedAt: now - 5 * MIN, filled: false, losingSince: undefined, validityAskedAt: undefined },
]);
positions = [{ ticket: "7001", symbol: "XAUUSD", type: "buy", lots: 0.04, openPrice: 2348, currentPrice: 2352, pnl: 4 }];
const eaWithPending = { ...deps, eaState: () => ({ positions, pendingOrders: [{ ticket: "7002", symbol: "EURUSD", type: "buy_limit", lots: 0.01, price: 1.08 }] }) };
// A reply to the gold signal saying "close half" -> card -> Do it
script.push([{ id: "u1", name: "report_post", arguments: { kind: "update", action: "close_partial", fraction: 0.5 } }]);
await onNousPost(eaWithPending as never, { ...post, messageId: 60, text: "secure half here guys", replyToMessageId: 50 }, now);
let updCard = sentRich.at(-1)!;
assert.match(updCard.blocks[0].text!, /close 50% of it/);
assert.ok(updCard.blocks.find((b) => b.type === "table")!.cells!.some((r) => r[0].includes("#7001")), "the reply picks the gold trade");
const [doIt, ignore] = updCard.reply_markup!.inline_keyboard[0].map((b) => b.callback_data);
assert.ok(doIt.startsWith("nous:uy:") && ignore.startsWith("nous:un:"));
assert.equal(closes.length, 0, "nothing done before the tap");
await (await import("../src/nous/service.js")).applyNousUpdate(eaWithPending as never, doIt.split(":")[2], now + MIN);
assert.deepEqual(closes, [["7001", 0.02]]);
// "SL to BE" on gold
const modsBefore = modifies.length;
script.push([{ id: "u2", name: "report_post", arguments: { kind: "update", action: "breakeven", symbol: "gold" } }]);
await onNousPost(eaWithPending as never, { ...post, messageId: 61, text: "Gold move SL to BE" }, now);
updCard = sentRich.at(-1)!;
await (await import("../src/nous/service.js")).applyNousUpdate(eaWithPending as never, updCard.reply_markup!.inline_keyboard[0][0].callback_data.split(":")[2], now + MIN);
assert.deepEqual(modifies.slice(modsBefore), [["7001", { sl: 2348 }]]);
// "cancel the EURUSD limit" -> deletes the unfilled order
script.push([{ id: "u3", name: "report_post", arguments: { kind: "update", action: "cancel", symbol: "EURUSD" } }]);
await onNousPost(eaWithPending as never, { ...post, messageId: 62, text: "cancel eurusd limit" }, now);
updCard = sentRich.at(-1)!;
await (await import("../src/nous/service.js")).applyNousUpdate(eaWithPending as never, updCard.reply_markup!.inline_keyboard[0][0].callback_data.split(":")[2], now + MIN);
assert.deepEqual(cancels, ["7002"]);
// An update when nothing from that channel is open costs no model call at all
store.saveNousTrades(userId, []);
const before12 = calls;
await onNousPost(deps as never, { ...post, messageId: 63, text: "close now" }, now);
assert.equal(calls, before12);
console.log("   ✓\n");

console.log("[13] The Telegram login is stored encrypted");
store.saveNousLogin(userId, { apiId: 123, apiHash: "0123456789abcdef0123456789abcdef", session: "SESSION-SECRET", account: "Me" });
const raw = (await import("node:fs")).readFileSync(join(root, "data", "nous", userId, "config.json"), "utf8");
assert.ok(!raw.includes("SESSION-SECRET") && !raw.includes("0123456789abcdef0123456789abcdef"));
assert.equal(store.getNousLogin(userId)?.session, "SESSION-SECRET");
console.log("   ✓\n");

console.log(`[14] Lagos time: ${store.lagosTime(now)}`);
assert.match(store.lagosTime(now), /11:00 \(Lagos\)/, "10:00 UTC is 11:00 in Lagos");
console.log("   ✓\n");

console.log("=== ALL ASSERTIONS PASSED ===");
process.exit(0);
