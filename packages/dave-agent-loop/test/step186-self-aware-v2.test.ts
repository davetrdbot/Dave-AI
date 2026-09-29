import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "dave-sa2-"));
process.env.DAVE_DATA_ROOT = root;

const { DaveDatabase } = await import("@dave/db");
const trading = await import("@dave/trading");
const { advanceMonitor } = await import("../src/trade-monitor-store.js");
const sweep = await import("../src/trade-monitor-sweep.js");
const { checkVerdict, resetReviewLimits } = await import("../src/self-aware-review.js");
const { alertKindStats, outcomeLine, listAlertOutcomes } = await import("../src/alert-outcomes.js");
const { listExitRules } = await import("../src/exit-rules.js");

const db = new DaveDatabase(join(root, "dave.sqlite"));
const T = Date.now();
const min = (n: number) => n * 60_000;

function eaDir(u: string) {
  const d = join(root, "data", "ea-bridge", u);
  mkdirSync(d, { recursive: true });
  return d;
}
const setPositions = (u: string, positions: unknown[]) => writeFileSync(join(eaDir(u), "last-known-state.json"), JSON.stringify({ positions, pendingOrders: [] }));
const setSnapshot = (u: string, updatedAt: number, balance = 1000) => writeFileSync(join(eaDir(u), "account-snapshot.json"), JSON.stringify({ account: "1", balance, updatedAt }));

// A BUY at 100 with its stop at 90: 1R = 10 price units.
const obs = (price: number, pnl: number, extra: Record<string, unknown> = {}) => ({ ticket: "1", symbol: "XAUUSD", direction: "buy" as const, openPrice: 100, sl: 90, tp: 130, currentPrice: price, pnl, reason: "sweep of the Asian low", ...extra });
const kinds = (r: { alerts: { kind: string }[] }) => r.alerts.map((a) => a.kind);

console.log("[1] Winner turned loser -- invisible before (the profit checks only ran while green)");
let r = advanceMonitor(undefined, obs(100, 0), T);
r = advanceMonitor(r.monitor, obs(107, 7), T + min(2));
assert.equal(r.monitor.mfeR, 0.7);
r = advanceMonitor(r.monitor, obs(98, -2), T + min(4));
assert.ok(kinds(r).includes("roundTrip"), "a +0.7R winner now red fires roundTrip");
assert.equal(r.monitor.maeR, -0.2);
r = advanceMonitor(r.monitor, obs(97, -3), T + min(5));
assert.ok(!kinds(r).includes("roundTrip"), "once, not every sweep");
r = advanceMonitor(r.monitor, obs(106, 6), T + min(7));
r = advanceMonitor(r.monitor, obs(99, -1), T + min(9));
assert.ok(kinds(r).includes("roundTrip"), "re-arms after it's a winner again");
let q = advanceMonitor(undefined, obs(100, 0, { ticket: "2" }), T);
q = advanceMonitor(q.monitor, obs(103, 3, { ticket: "2" }), T + min(1));
q = advanceMonitor(q.monitor, obs(99, -1, { ticket: "2" }), T + min(2));
assert.ok(!kinds(q).includes("roundTrip"), "+0.3R is not a winner");

console.log("[2] Never went green");
let n = advanceMonitor(undefined, obs(99, -1, { ticket: "3" }), T);
for (let i = 1; i <= 19; i++) n = advanceMonitor(n.monitor, obs(98, -2, { ticket: "3" }), T + min(i));
assert.ok(!n.monitor.alerts.neverGreen);
n = advanceMonitor(n.monitor, obs(98, -2, { ticket: "3" }), T + min(20));
assert.ok(kinds(n).includes("neverGreen"), "20 min, never once in profit");

console.log("[3] Racing to the stop -- a fast move, not a slow bleed");
let f = advanceMonitor(undefined, obs(99, -1, { ticket: "4" }), T);
f = advanceMonitor(f.monitor, obs(98.5, -1.5, { ticket: "4" }), T + min(1));
f = advanceMonitor(f.monitor, obs(94, -6, { ticket: "4" }), T + min(2));
assert.ok(kinds(f).includes("racing"), "0.5R against in 2 minutes");
assert.equal(f.monitor.raceR, 0.5);
let slow = advanceMonitor(undefined, obs(99, -1, { ticket: "5" }), T);
for (let i = 1; i <= 12; i++) slow = advanceMonitor(slow.monitor, obs(99 - i * 0.5, -1 - i * 0.5, { ticket: "5" }), T + min(i));
assert.ok(!slow.monitor.cooldowns?.racing, "0.05R a minute is a bleed, not a race");

console.log("[4] No stop loss -- and MT5's 0 is never read as a price");
let ns = advanceMonitor(undefined, obs(99, -1, { ticket: "6", sl: 0, tp: 0 }), T);
assert.equal(ns.monitor.sl, undefined, "sl 0 = no stop");
assert.equal(ns.monitor.tp, undefined);
assert.ok(!kinds(ns).includes("noStop"), "a short grace for the stop to attach");
ns = advanceMonitor(ns.monitor, obs(99, -1, { ticket: "6", sl: 0, tp: 0 }), T + min(1));
assert.ok(kinds(ns).includes("noStop"));
assert.ok(!kinds(ns).includes("slNear") && !kinds(ns).includes("deepLoss"), "no stop-based nonsense against a 0 stop");

console.log("[5] One message per trade, R status line, idea once");
const U = "sa2-user";
setSnapshot(U, T);
const sent: string[] = [];
setPositions(U, [{ ticket: "77", symbol: "XAUUSD", type: "buy", lots: 0.1, openPrice: 100, sl: 90, tp: 130, currentPrice: 107, pnl: 7 }]);
await sweep.runTradeMonitorSweep({ db, userId: U, notify: async (t) => void sent.push(t) }, T);
// Straight to 0.9R against, 89%+ to the stop AND a round trip AND racing -- one sweep.
setPositions(U, [{ ticket: "77", symbol: "XAUUSD", type: "buy", lots: 0.1, openPrice: 100, sl: 90, tp: 130, currentPrice: 91, pnl: -9 }]);
setSnapshot(U, T + min(2));
const fired = await sweep.runTradeMonitorSweep({ db, userId: U, notify: async (t) => void sent.push(t) }, T + min(2));
const k = fired.map((a) => a.kind);
assert.ok(k.includes("roundTrip") && k.includes("slNear") && k.includes("racing"), `several at once: ${k.join(",")}`);
assert.equal(sent.length, 1, "one message for the trade, not one per alert");
const msg = sent[0];
assert.match(msg, /📊 XAUUSD BUY #77: -0\.9R · P\/L -9\.00 · 2 min in · best 0\.7R \/ worst -0\.9R · 90% to the stop/);
assert.equal(msg.split("📌 Original idea").length - 1, 1, "the idea is quoted once");
assert.match(msg, /WINNER TURNED LOSER/);
assert.match(msg, /RACING TO THE STOP/);
assert.match(msg, /NEARLY STOPPED OUT/);
assert.match(msg, /🛟 No exit rule on it/);

console.log("[6] A frozen feed: said once, the monitors held still, and told when it's back");
const F = "sa2-feed";
setPositions(F, [{ ticket: "5", symbol: "EURUSD", type: "sell", lots: 0.1, openPrice: 1.1, sl: 1.11, tp: 1.08, currentPrice: 1.1, pnl: 0 }]);
setSnapshot(F, T);
const feedSent: string[] = [];
await sweep.runTradeMonitorSweep({ db, userId: F, notify: async (t) => void feedSent.push(t) }, T);
// 20 minutes later, still the same snapshot: MT5 went quiet. Without the guard this would be "stuck 15 min".
const quiet = await sweep.runTradeMonitorSweep({ db, userId: F, notify: async (t) => void feedSent.push(t) }, T + min(20));
assert.deepEqual(quiet, [], "no alerts from a frozen picture");
assert.match(feedSent.join("\n"), /MONITOR BLIND[\s\S]*20 min/);
await sweep.runTradeMonitorSweep({ db, userId: F, notify: async (t) => void feedSent.push(t) }, T + min(21));
assert.equal(feedSent.filter((m) => /MONITOR BLIND/.test(m)).length, 1, "said once per outage");
setSnapshot(F, T + min(22));
await sweep.runTradeMonitorSweep({ db, userId: F, notify: async (t) => void feedSent.push(t) }, T + min(22));
assert.match(feedSent.at(-1)!, /reporting again/);

console.log("[7] Account heat: the trades together");
const H = "sa2-heat";
setSnapshot(H, T, 1000);
setPositions(H, [
  { ticket: "a", symbol: "EURUSD", type: "buy", lots: 0.1, openPrice: 1.1, sl: 1.09, currentPrice: 1.098, pnl: -12 },
  { ticket: "b", symbol: "GBPUSD", type: "buy", lots: 0.1, openPrice: 1.3, sl: 1.29, currentPrice: 1.297, pnl: -11 },
  { ticket: "c", symbol: "AUDUSD", type: "buy", lots: 0.1, openPrice: 0.7, sl: 0.69, currentPrice: 0.699, pnl: -9 },
]);
const heatSent: string[] = [];
await sweep.runTradeMonitorSweep({ db, userId: H, notify: async (t) => void heatSent.push(t) }, T);
const heat = heatSent.find((m) => /ACCOUNT HEAT/.test(m));
assert.ok(heat, "3 trades, all losing, -32 = 3.2% of the balance");
assert.match(heat!, /3 open trades, 3 losing -- together -32\.00 \(3\.2% of the balance\)/);
assert.match(heat!, /All BUYS -- this is one bet placed 3 times/);
await sweep.runTradeMonitorSweep({ db, userId: H, notify: async (t) => void heatSent.push(t) }, T + min(1));
assert.equal(heatSent.filter((m) => /ACCOUNT HEAT/.test(m)).length, 1, "cooldown");

console.log("[8] Outcome memory: what happened after each alert");
setPositions(U, []);
setSnapshot(U, T + min(3));
await sweep.runTradeMonitorSweep({ db, userId: U, notify: async () => {} }, T + min(3));
const rows = listAlertOutcomes(U);
assert.ok(rows.some((o) => o.kind === "roundTrip" && o.finalPnl === -9 && o.pnlAtAlert === -9), "the round trip and how it ended");
// Enough history for a line in the next alert.
// MT5 keeps reporting through all of this (a fresh snapshot each sweep).
const live = async (u: string, at: number) => {
  setSnapshot(u, at);
  await sweep.runTradeMonitorSweep({ db, userId: u, notify: async () => {} }, at);
};
for (let i = 0; i < 6; i++) {
  const t = `h${i}`;
  const won = i < 4;
  setPositions(U, [{ ticket: t, symbol: "XAUUSD", type: "buy", lots: 0.1, openPrice: 100, sl: 90, currentPrice: 107, pnl: 7 }]);
  await live(U, T + min(10 + i * 3));
  setPositions(U, [{ ticket: t, symbol: "XAUUSD", type: "buy", lots: 0.1, openPrice: 100, sl: 90, currentPrice: 98, pnl: -2 }]);
  await live(U, T + min(11 + i * 3));
  setPositions(U, [{ ticket: t, symbol: "XAUUSD", type: "buy", lots: 0.1, openPrice: 100, sl: 90, currentPrice: won ? 105 : 92, pnl: won ? 5 : -8 }]);
  await live(U, T + min(11.5 + i * 3));
  setPositions(U, []);
  await live(U, T + min(12 + i * 3));
}
const st = alertKindStats(U, "roundTrip")!;
assert.equal(st.n, 7);
assert.equal(st.closedGreen, 4);
assert.match(outcomeLine(U, "roundTrip")!, /of the last 7 trades that hit this, 4 still closed green \(57%\)/);

console.log("[9] The review's safety rules -- enforced in code, not left to the model");
const pos = { type: "buy" as const, lots: 0.3, openPrice: 100, sl: 90, currentPrice: 104, pnl: 4 };
const base = { thesis: "intact" as const, confidence: 70, reason: "x" };
assert.deepEqual(checkVerdict({ ...base, verdict: "TIGHTEN_STOP", newSl: 85 }, pos, "act").act, false, "never widen");
assert.match(checkVerdict({ ...base, verdict: "TIGHTEN_STOP", newSl: 85 }, pos, "act").problem!, /WIDEN/);
assert.match(checkVerdict({ ...base, verdict: "TIGHTEN_STOP", newSl: 105 }, pos, "act").problem!, /wrong side/);
assert.equal(checkVerdict({ ...base, verdict: "TIGHTEN_STOP", newSl: 98 }, pos, "act").act, true);
assert.equal(checkVerdict({ ...base, verdict: "TIGHTEN_STOP", newSl: 98 }, pos, "advise").act, false, "advise never acts");
assert.match(checkVerdict({ ...base, verdict: "BREAKEVEN" }, { ...pos, currentPrice: 97, pnl: -3 }, "act").problem!, /in profit/);
assert.match(checkVerdict({ ...base, verdict: "CLOSE" }, pos, "act").problem!, /judged broken/, "a full close needs a broken idea");
assert.equal(checkVerdict({ ...base, thesis: "broken", verdict: "CLOSE" }, pos, "act").act, true);
assert.match(checkVerdict({ ...base, verdict: "PARTIAL_CLOSE", partialPercent: 95 }, pos, "act").problem!, /10-90/);
assert.match(checkVerdict({ ...base, verdict: "PARTIAL_CLOSE", partialPercent: 50 }, { ...pos, lots: 0.01 }, "act").problem!, /can't be split/);

console.log("[10] The review end to end: advise (default) touches nothing; act does, within the rules");
const R = "sa2-review";
setSnapshot(R, T);
let verdict: Record<string, unknown> = { verdict: "EXIT_RULE", thesis: "weakened", confidence: 64, reason: "M5 keeps failing at 101.5; the sweep low at 97 is holding but nothing is pushing.", closeAtProfit: 2, closeAtLoss: -8 };
let prompt = "";
const provider = {
  generate: async (req: { messages: { content: unknown }[] }) => {
    prompt = req.messages.map((m) => String(m.content)).join("\n");
    return { text: "", toolCalls: [{ id: "c1", name: "self_aware_verdict", arguments: verdict }] };
  },
} as never;
const candles = Array.from({ length: 30 }, (_, i) => ({ t: new Date(T - (30 - i) * 300_000).toISOString(), o: 100, h: 101, l: 99, c: 100 - (i % 3), size_vs_atr: 1 }));
const analysis = { get: async <X>() => candles as unknown as X };
const calls: string[] = [];
const executor = {
  modifyOrder: async (t: string, p: { sl?: number }) => void calls.push(`modify ${t} sl=${p.sl}`),
  closePosition: async (t: string, lots?: number) => (calls.push(`close ${t}${lots ? ` ${lots}` : ""}`), { closedLots: lots ?? 0.2, remainingLots: 0 }),
} as never;
const rSent: string[] = [];
const deps = { db, userId: R, executor, notify: async (t: string) => void rSent.push(t), review: { provider: () => provider, analysis }, awaitReviews: true };
// A trade chopping in loss for 10 minutes: loss10m calls for a decision.
setPositions(R, [{ ticket: "9", symbol: "XAUUSD", type: "buy", lots: 0.2, openPrice: 100, sl: 90, tp: 120, currentPrice: 99, pnl: -1 }]);
for (let i = 0; i <= 10; i++) {
  setSnapshot(R, T + min(i));
  await sweep.runTradeMonitorSweep(deps, T + min(i));
}
const review = rSent.find((m) => /SELF-REVIEW/.test(m));
assert.ok(review, "the loss10m alert got a review");
assert.match(review!, /Verdict: Arm an exit rule \(close at \+2\.00, cut at -8\) -- idea weakened \(64%\)/);
assert.match(review!, /Suggestion only/, "advise is the default");
assert.equal(listExitRules(R).length, 0, "and nothing was armed");
assert.match(prompt, /ORIGINAL IDEA: sweep|ORIGINAL IDEA:/);
assert.match(prompt, /M5 candles/);
assert.match(prompt, /-0\.1R/, "the trade's R is in the review");

// Act mode: the same verdict is carried out.
trading.setSelfAwareMode(R, "act");
resetReviewLimits();
rSent.length = 0;
setPositions(R, [{ ticket: "10", symbol: "XAUUSD", type: "buy", lots: 0.2, openPrice: 100, sl: 90, tp: 120, currentPrice: 99, pnl: -1 }]);
for (let i = 11; i <= 21; i++) {
  setSnapshot(R, T + min(i));
  await sweep.runTradeMonitorSweep(deps, T + min(i));
}
assert.match(rSent.find((m) => /SELF-REVIEW/.test(m))!, /✅ Done: exit rule armed -- closes at \+2, cuts at -8/);
assert.equal(listExitRules(R)[0].ticket, "10");

// Act mode, a CLOSE on an idea that's only weakened: refused, stays a suggestion.
resetReviewLimits();
rSent.length = 0;
verdict = { verdict: "CLOSE", thesis: "weakened", confidence: 55, reason: "nothing is happening" };
setPositions(R, [{ ticket: "11", symbol: "XAUUSD", type: "buy", lots: 0.2, openPrice: 100, sl: 90, tp: 120, currentPrice: 99, pnl: -1 }]);
for (let i = 22; i <= 32; i++) {
  setSnapshot(R, T + min(i));
  await sweep.runTradeMonitorSweep(deps, T + min(i));
}
assert.match(rSent.find((m) => /SELF-REVIEW/.test(m))!, /Not done: a full close on my own needs the idea judged broken/);
assert.ok(!calls.some((c) => c.startsWith("close 11")), "the trade was not closed");

// Off: no review at all.
trading.setSelfAwareMode(R, "off");
resetReviewLimits();
rSent.length = 0;
setPositions(R, [{ ticket: "12", symbol: "XAUUSD", type: "buy", lots: 0.2, openPrice: 100, sl: 90, tp: 120, currentPrice: 99, pnl: -1 }]);
for (let i = 33; i <= 43; i++) {
  setSnapshot(R, T + min(i));
  await sweep.runTradeMonitorSweep(deps, T + min(i));
}
assert.ok(rSent.some((m) => /losing for/.test(m)), "the alert still goes out");
assert.ok(!rSent.some((m) => /SELF-REVIEW/.test(m)), "but no review");

// The verdicts join the outcome memory when their trades close.
setPositions(R, []);
setSnapshot(R, T + min(44));
await sweep.runTradeMonitorSweep(deps, T + min(44));
assert.ok(alertKindStats(R, "verdict:EXIT_RULE"), "verdicts are remembered with how the trade ended");

console.log("\n=== step186 self-aware v2: ALL ASSERTIONS PASSED ===");
