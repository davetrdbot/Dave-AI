import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workDir = mkdtempSync(join(tmpdir(), "dave-growth-route-"));
process.env.DAVE_DATA_ROOT = workDir;
process.env.DATA_DIR = join(workDir, "db");
delete process.env.OWNER_USER_ID;

const { NextRequest } = await import("next/server");
const { createPairingCode, redeemPairingCode } = await import("../server/device-auth.js");
const trading = await import("@dave/trading");
const growthRoute = await import("../app/api/app/growth/route.js");
const historyRoute = await import("../app/api/app/history/route.js");

/** The app's Growth screen: goal, score, strategy card, versions, neurons -- and its buttons. */
console.log("=== Step 178: /api/app/growth ===\n");
const USER = "default";
const { code } = createPairingCode(USER);
const { token } = redeemPairingCode(USER, code, "test phone");
type Handler = (req: InstanceType<typeof NextRequest>) => Promise<Response>;
async function call(handler: Handler, method: string, body?: unknown, auth = true): Promise<{ status: number; json: any }> {
  const req = new NextRequest("http://localhost/api/app/growth", { method, headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await handler(req);
  return { status: res.status, json: await res.json() };
}

mkdirSync(join(workDir, "data", "trade-events", USER), { recursive: true });
const now = Date.now();
writeFileSync(join(workDir, "data", "trade-events", USER, "closed-trades.json"), JSON.stringify([10, -5, 12, -5].map((pnl, i) => ({ ticket: String(i), symbol: "EURUSD", pnl, reason: "tp", closedAt: now - (4 - i) * 3600_000 }))));

assert.equal((await call(growthRoute.GET as Handler, "GET", undefined, false)).status, 401, "needs a paired device");
let r = await call(growthRoute.GET as Handler, "GET");
assert.equal(r.status, 200);
assert.equal(r.json.current.v, 1);
assert.equal(r.json.status.score.metrics.trades, 4);
assert.equal(r.json.neurons.length, trading.DEFAULT_NEURONS.length);
assert.ok(r.json.definition.failure.length === 3);
console.log("   ✓ GET: goal, score, v01, neurons");

r = await call(growthRoute.POST as Handler, "POST", { action: "goals", goals: { targetMonthlyReturnPct: 12, maxLosingStreak: 4 } });
assert.equal(r.status, 200);
assert.equal(trading.getGrowthGoals(USER).targetMonthlyReturnPct, 12);
r = await call(growthRoute.POST as Handler, "POST", { action: "goals", goals: { maxDrawdownPct: 500 } });
assert.equal(r.status, 400, r.json.error);
console.log("   ✓ goals edit + bounds");

r = await call(growthRoute.POST as Handler, "POST", { action: "learn", neuron: "sessions", text: "EURUSD fakes out in the first 10 minutes of New York." });
assert.equal(r.status, 200);
const fact = r.json.neurons.find((n: any) => n.id === "sessions").facts[0];
assert.equal(fact.source, "trader");
r = await call(growthRoute.POST as Handler, "POST", { action: "forget", id: fact.id });
assert.equal(r.json.neurons.find((n: any) => n.id === "sessions").facts.length, 0);
console.log("   ✓ teach / forget a fact");

r = await call(growthRoute.POST as Handler, "POST", { action: "reflect" });
assert.ok(existsSync(join(workDir, "data", "trading", USER, "growth", "reflect-request.json")), "request dropped for the bot");
r = await call(growthRoute.POST as Handler, "POST", { action: "stop_test" });
assert.equal(r.status, 409, "nothing under test");
console.log("   ✓ reflect request + stop_test guard");
{
  const req = new NextRequest(`http://localhost/api/app/history?from=${now - 3.5 * 3600_000}`, { headers: { authorization: `Bearer ${token}` } });
  const h = await ((historyRoute.GET as Handler)(req)).then((r) => r.json());
  assert.equal(h.summary.trades, 3, "only the trades inside the period");
  assert.equal(h.summary.netPnl, 2);
  assert.equal(h.trades[0].closedBy, "tp");
  const all = await ((historyRoute.GET as Handler)(new NextRequest("http://localhost/api/app/history", { headers: { authorization: `Bearer ${token}` } }))).then((r) => r.json());
  assert.equal(all.summary.trades, 4);
  assert.equal(all.bySymbol[0].symbol, "EURUSD");
  console.log("   ✓ /api/app/history: period filter, summary, per pair");
}
console.log("\nAll Step 178 route checks passed.");
process.exit(0);
