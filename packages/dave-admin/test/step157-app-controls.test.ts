import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workDir = mkdtempSync(join(tmpdir(), "dave-appcontrols-"));
process.env.DAVE_DATA_ROOT = workDir;
process.env.DATA_DIR = join(workDir, "db");
delete process.env.OWNER_USER_ID;

const { NextRequest } = await import("next/server");
const { createPairingCode, redeemPairingCode } = await import("../server/device-auth.js");
const trading = await import("@dave/trading");
const memory = await import("@dave/memory");
const knowledge = await import("@dave/knowledge");
const eaBridge = await import("@dave/ea-bridge");
const brain = await import("@dave/brain");
const agentTimeout = await import("../../dave-agent-loop/src/provider-timeout-config.js");

const settingsRoute = await import("../app/api/app/settings/route.js");
const brainRoute = await import("../app/api/app/brain/route.js");
const skillsRoute = await import("../app/api/app/skills/route.js");
const tradesRoute = await import("../app/api/app/trades/route.js");
const providerRoute = await import("../app/api/app/provider/route.js");
const dashboardRoute = await import("../app/api/app/dashboard/route.js");

/**
 * The phone app's write surface: settings, Baseten, memory and knowledge editing, skill editing,
 * and closing a trade. Every handler is driven through its real exported route, with a real
 * paired-device token, and every effect is checked in the store the BOT reads -- not in the
 * route's own response, which could agree with itself and still write the wrong file.
 */

console.log("=== Step 157: app controls -- settings, Baseten, brain editing, close trade, P&L history ===\n");

const USER = "default"; // no OWNER_USER_ID: the owner is "default"
const { code } = createPairingCode(USER);
const { token } = redeemPairingCode(USER, code, "test phone");

type Handler = (req: InstanceType<typeof NextRequest>) => Promise<Response>;
async function call(handler: Handler, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const req = new NextRequest(`http://localhost${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handler(req);
  return { status: res.status, json: await res.json() };
}

// ---------------------------------------------------------------------------
console.log("[1] Settings: every change lands in the store the bot reads\n");

let r = await call(settingsRoute.GET as Handler, "GET", "/api/app/settings");
assert.equal(r.status, 200);
assert.equal(r.json.trading.riskReward.value, 1, "default risk:reward is 1");
assert.equal(r.json.alerts.toggles.length, trading.ALERT_CATEGORIES.length, "every alert category is listed");

r = await call(settingsRoute.POST as Handler, "POST", "/api/app/settings", { id: "riskReward", value: 2 });
assert.equal(r.status, 200);
assert.equal(trading.getMinRiskReward(USER), 2);
assert.equal(r.json.trading.riskReward.value, 2, "the response is the freshly read state");

r = await call(settingsRoute.POST as Handler, "POST", "/api/app/settings", { id: "riskReward", value: -1 });
assert.equal(r.status, 400, "out of range is refused with a readable reason");
assert.ok(typeof r.json.error === "string" && r.json.error.length > 0);
assert.equal(trading.getMinRiskReward(USER), 2, "a refused change leaves the stored value alone");

r = await call(settingsRoute.POST as Handler, "POST", "/api/app/settings", { id: "stopLoss", value: { mode: "on", value: 30 } });
assert.equal(r.status, 200);
assert.equal(trading.getRiskSettings(USER).slMode, "on");
assert.equal(trading.getRiskSettings(USER).slValue, 30);
r = await call(settingsRoute.POST as Handler, "POST", "/api/app/settings", { id: "lotSize", value: { mode: "on" } });
assert.equal(r.status, 400, "on without a value is refused");

r = await call(settingsRoute.POST as Handler, "POST", "/api/app/settings", { id: "maxOpenTrades", value: 4 });
assert.equal(r.status, 200);
assert.equal(trading.getRiskSettings(USER).maxOpenTrades, 4, "a protected limit is applied when the trader sets it");

r = await call(settingsRoute.POST as Handler, "POST", "/api/app/settings", { id: "alert:range", value: false });
assert.equal(r.status, 200);
assert.equal(trading.isAlertEnabled(USER, "range"), false);
r = await call(settingsRoute.POST as Handler, "POST", "/api/app/settings", { id: "alert:nonsense", value: false });
assert.equal(r.status, 400);

r = await call(settingsRoute.POST as Handler, "POST", "/api/app/settings", { id: "session", value: "london" });
assert.equal(trading.getTradingSession(USER), "london");
r = await call(settingsRoute.POST as Handler, "POST", "/api/app/settings", { id: "deepLossPercent", value: 60 });
assert.equal(trading.getDeepLossAlertPercent(USER), 60);
r = await call(settingsRoute.POST as Handler, "POST", "/api/app/settings", { id: "memoryWriteApproval", value: true });
assert.equal(memory.getWriteApprovalSetting(USER), true);

// The timeout lives in @dave/agent-loop, which this process can't import -- its file is mirrored.
// Checked against the agent-loop module itself, so a drift in either one fails here.
r = await call(settingsRoute.POST as Handler, "POST", "/api/app/settings", { id: "primaryTimeoutSeconds", value: 30 });
assert.equal(r.status, 200);
assert.equal(agentTimeout.getProviderTimeoutConfig(USER).primarySeconds, 30, "the bot reads the timeout the app wrote");
assert.equal(agentTimeout.getProviderTimeoutConfig(USER).fallbackSeconds, 5, "the other timeout keeps its default");

r = await call(settingsRoute.POST as Handler, "POST", "/api/app/settings", { id: "nope", value: 1 });
assert.equal(r.status, 400);
console.log("   ✓ risk:reward, SL mode, protected limit, alert toggle, session, deep-loss, memory approval, AI timeout");
console.log("   ✓ invalid values refused with a reason and nothing written\n");

// ---------------------------------------------------------------------------
console.log("[2] Baseten: keys join the bot's rotation pool, and the real key never comes back\n");

const RAW_KEY = "bt-live-abcdefghijklmnopqrstuvwxyz0123456789";
r = await call(providerRoute.POST as Handler, "POST", "/api/app/provider", { action: "add-key", apiKey: RAW_KEY });
assert.equal(r.status, 200);
assert.equal(r.json.keys.length, 1);
assert.ok(!JSON.stringify(r.json).includes(RAW_KEY), "the raw API key is never returned");
assert.equal(r.json.keys[0].model, "deepseek-ai/DeepSeek-V3.2", "no model given -> the catalog default");

r = await call(providerRoute.POST as Handler, "POST", "/api/app/provider", { action: "set-model", model: "moonshotai/Kimi-K2-Instruct" });
assert.equal(r.json.keys[0].model, "moonshotai/Kimi-K2-Instruct");

r = await call(providerRoute.POST as Handler, "POST", "/api/app/provider", { action: "use-baseten" });
assert.equal(r.json.isPrimary, true);
assert.equal(brain.getModelConfig(USER).primary, "baseten", "the bot's model config now routes to Baseten");

r = await call(providerRoute.POST as Handler, "POST", "/api/app/provider", { action: "remove-key", keyId: "missing" });
assert.equal(r.status, 404);
console.log("   ✓ add, set model, make primary provider; key masked; unknown key 404\n");

// ---------------------------------------------------------------------------
console.log("[3] Brain: typing into memory and knowledge, and resetting memory\n");

r = await call(brainRoute.POST as Handler, "POST", "/api/app/brain", { action: "memory-add", target: "user", content: "Trades gold only on Fridays." });
assert.equal(r.status, 200);
assert.ok(memory.readMemoryEntries(USER, "user").includes("Trades gold only on Fridays."), "Dave's own memory file has it");

r = await call(brainRoute.POST as Handler, "POST", "/api/app/brain", { action: "memory-replace", target: "user", oldText: "Trades gold only on Fridays.", content: "Trades gold on Thursdays and Fridays." });
assert.equal(r.status, 200);
assert.ok(memory.readMemoryEntries(USER, "user").includes("Trades gold on Thursdays and Fridays."));

r = await call(brainRoute.POST as Handler, "POST", "/api/app/brain", { action: "memory-remove", target: "user", oldText: "not there" });
assert.equal(r.status, 404, "editing an entry that has changed is reported, not guessed at");

r = await call(brainRoute.POST as Handler, "POST", "/api/app/brain", { action: "memory-add", target: "memory", content: "Prefers 1% risk." });
r = await call(brainRoute.POST as Handler, "POST", "/api/app/brain", {
  action: "knowledge-add",
  title: "Gold fades the NY open",
  useWhen: "XAUUSD entries in the first 30 min of New York",
  content: "The first NY push on gold reverses more often than not.",
});
assert.equal(r.status, 200);
const saved = knowledge.knowledgeList(USER);
assert.equal(saved.length, 1, "knowledge saved in one step");
assert.equal(knowledge.listKnowledgeDrafts(USER).length, 0, "no draft left behind");

r = await call(brainRoute.GET as Handler, "GET", `/api/app/brain?knowledgeId=${saved[0].id}`);
assert.equal(r.json.content, "The first NY push on gold reverses more often than not.", "one lesson opens in full");

r = await call(brainRoute.POST as Handler, "POST", "/api/app/brain", { action: "reset-memory" });
assert.equal(r.status, 200);
assert.ok(!memory.readMemoryEntries(USER, "user").includes("Trades gold on Thursdays and Fridays."), "reset clears what Dave knows about you");
assert.ok(!memory.readMemoryEntries(USER, "memory").includes("Prefers 1% risk."));
assert.equal(knowledge.knowledgeList(USER).length, 1, "reset keeps knowledge, exactly as /reset does");

r = await call(brainRoute.POST as Handler, "POST", "/api/app/brain", { action: "knowledge-delete", id: saved[0].id });
assert.equal(knowledge.knowledgeList(USER).length, 0);
console.log("   ✓ add / edit / stale-edit refused; knowledge add + open + delete; reset keeps knowledge\n");

// ---------------------------------------------------------------------------
console.log("[4] Skills: write one by hand, then edit it; built-ins stay as shipped\n");

r = await call(skillsRoute.POST as Handler, "POST", "/api/app/skills", { action: "create", name: "My breakout", description: "Asian range", content: "Buy the break." });
assert.equal(r.status, 200);
const skillId = r.json.skill.id as string;
r = await call(skillsRoute.POST as Handler, "POST", "/api/app/skills", { action: "update", skillId, content: "Buy the break, only after a retest." });
assert.equal(r.status, 200);
assert.equal(r.json.skill.content, "Buy the break, only after a retest.");
r = await call(skillsRoute.POST as Handler, "POST", "/api/app/skills", { action: "update", skillId: "missing", content: "x" });
assert.equal(r.status, 404);
console.log("   ✓ create + edit; unknown skill 404\n");

// ---------------------------------------------------------------------------
console.log("[5] Closing a trade queues a real EA command -- only for a trade that is open\n");

const stateDir = join(workDir, "data", "ea-bridge", USER);
mkdirSync(stateDir, { recursive: true });
writeFileSync(
  join(stateDir, "last-known-state.json"),
  JSON.stringify({ positions: [{ ticket: "9001", symbol: "XAUUSD", type: "buy", lots: 0.1, openPrice: 2650, pnl: 12 }], pendingOrders: [] })
);
assert.equal(eaBridge.getLastKnownState(USER).positions.length, 1, "seeded state is the one the bridge reads");

r = await call(tradesRoute.POST as Handler, "POST", "/api/app/trades", { action: "close", ticket: "1234" });
assert.equal(r.status, 404, "a ticket that isn't open is refused");
assert.equal(eaBridge.peekQueue(USER).length, 0, "and nothing was queued for it");

r = await call(tradesRoute.POST as Handler, "POST", "/api/app/trades", { action: "close", ticket: "9001" });
assert.equal(r.status, 200);
const queue = eaBridge.peekQueue(USER);
assert.equal(queue.length, 1);
assert.deepEqual({ action: queue[0].action, ticket: (queue[0] as { ticket: string }).ticket }, { action: "close", ticket: "9001" });
console.log("   ✓ close queued in the EA's command queue; stale ticket refused\n");

// ---------------------------------------------------------------------------
console.log("[6] P&L history: every EA close is kept, with its side, and the dashboard uses it\n");

eaBridge.appendTradeEvents(USER, [{ type: "opened", ticket: "9001", symbol: "XAUUSD", side: "buy", lots: 0.1, openPrice: 2650 }], Date.now() - 3_600_000);
eaBridge.appendTradeEvents(USER, [{ type: "closed", ticket: "9001", symbol: "XAUUSD", pnl: 25.5, reason: "tp" }]);
eaBridge.appendTradeEvents(USER, [{ type: "closed", ticket: "9002", symbol: "EURUSD", pnl: -8, reason: "sl" }]);
const history = eaBridge.readClosedTradeHistory(USER);
assert.equal(history.length, 2);
assert.equal(history[0].side, "buy", "the side is recovered from the matching open");
assert.equal(history[1].side, undefined, "no open seen -> side unknown, not invented");

r = await call(dashboardRoute.GET as Handler, "GET", "/api/app/dashboard");
assert.equal(r.status, 200);
assert.equal(r.json.trades.length, 2, "the dashboard returns the individual closes");
assert.equal(r.json.results.closedTrades, 2);
assert.equal(r.json.results.realisedPnl, 17.5);
assert.equal(r.json.results.wins, 1);
console.log("   ✓ closes recorded with side; dashboard results come from the EA's own close history\n");

console.log("=== Step 157 passed ===");
