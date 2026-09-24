import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const workDir = mkdtempSync(join(tmpdir(), "dave-mt5-cloud-"));
process.env.DAVE_DATA_ROOT = workDir;
process.env.MT5_EA_BASE_URL = "http://dave-bot.railway.internal:8080";
delete process.env.MT5_AGENT_URL;
delete process.env.MT5_AGENT_SECRET;

/**
 * The trader: "deploy a MT5 docker, so instead the bot asks you MT5 credentials and logs, then it
 * loads the EA, and the MT5 settings can be adjusted via the settings". The container side was run
 * for real under Wine (mt5/README.md, mt5/test_agent.py); this pins the bot side against a stand-in
 * container: the /mt5 Telegram flow, what reaches the container, and that the password never
 * reaches anything else.
 */

// --- a stand-in MT5 container agent ----------------------------------------------------------------
const seen: { path: string; secret?: string; body: any }[] = [];
let configured: any = null;
let marketWatch: string[] = [];
let metaquotesIds: string[] = [];
const agent = createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : undefined;
  seen.push({ path: req.url ?? "", secret: req.headers["x-dave-agent-secret"] as string | undefined, body });
  const reply = (code: number, obj: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (req.headers["x-dave-agent-secret"] !== "agent-secret-xyz") return reply(401, { error: "unauthorized" });
  if (req.url === "/configure") {
    configured = { login: body.login, server: body.server, symbol: body.symbol, period: body.period ?? "M1" };
    marketWatch = body.marketWatch ?? [];
    metaquotesIds = body.metaquotesIds ?? [];
    return reply(200, { ok: true });
  }
  if (req.url === "/settings") {
    if (body.marketWatch) marketWatch = body.marketWatch;
    if (body.metaquotesIds) metaquotesIds = body.metaquotesIds;
    configured = { ...configured, ...(body.symbol ? { symbol: body.symbol } : {}), ...(body.period ? { period: body.period } : {}) };
    return reply(200, { ok: true });
  }
  if (req.url === "/status")
    return reply(200, {
      installed: true,
      compiled: !!configured,
      running: !!configured,
      login: configured ? "logged-in" : "unknown",
      configured: !!configured,
      account: configured,
      inputs: {},
      marketWatch,
      metaquotesIds,
      phonePush: { state: metaquotesIds.length ? "on" : "off", detail: null, eaReports: metaquotesIds.length > 0 },
      relay: { count: 3, errors: 0, lastAt: Date.now() / 1000 - 2, lastStatus: 200, lastError: null },
    });
  return reply(404, { error: "not found" });
});
await new Promise<void>((r) => agent.listen(0, "127.0.0.1", () => r()));
const AGENT_URL = `http://127.0.0.1:${(agent.address() as { port: number }).port}`;

const { DaveDatabase } = await import("@dave/db");
const { getOrCreateEaWebhook, getMt5CloudAgent, MT5_CLOUD_TOOLS } = await import("@dave/ea-bridge");
const { upsertGroup, setActiveGroup } = await import("@dave/trading");
const flow = await import("../src/mt5-cloud-flow.js");
const { DAVE_COMMANDS } = await import("@dave/telegram");

console.log("=== Step 162: MT5 in Dave's container -- /mt5 flow, settings, and the password stays private ===\n");

const USER = "default";
const CHAT = 4242;
const db = new DaveDatabase(join(workDir, "d.db"));
const sent: { text: string; reply_markup?: any }[] = [];
const deleted: number[] = [];
const client: any = {
  sendMessage: async (p: any) => (sent.push({ text: p.text, reply_markup: p.reply_markup }), { message_id: sent.length }),
  editMessageText: async (p: any) => (sent.push({ text: p.text, reply_markup: p.reply_markup }), true),
  deleteMessage: async (p: any) => (deleted.push(p.message_id), true),
};
const deps: any = { db, client, userId: USER, publicBaseUrl: undefined, executor: undefined };
const lastText = () => sent[sent.length - 1]?.text ?? "";
const buttons = () => JSON.stringify(sent[sent.length - 1]?.reply_markup ?? {});

assert.ok(DAVE_COMMANDS.some((c) => c.command === "mt5"), "/mt5 is in the command menu");

console.log("[1] Not set up on the server: /mt5 says so, and asks the trader for nothing\n");
await flow.handleMt5Cloud(deps, CHAT);
assert.match(lastText(), /isn't set up on this server yet/);
assert.doesNotMatch(buttons(), /mt5c:agent|mt5c:connect/, "no address step, and nothing to connect to yet");
assert.equal(getMt5CloudAgent(USER), undefined);
console.log("   ✓\n");

console.log("[2] The container comes from the server's own settings -- the default address unless overridden\n");
process.env.MT5_AGENT_SECRET = "agent-secret-xyz";
assert.deepEqual(getMt5CloudAgent(USER), { url: "http://dave-mt5.railway.internal:8081", secret: "agent-secret-xyz" });
process.env.MT5_AGENT_URL = AGENT_URL;
assert.deepEqual(getMt5CloudAgent(USER), { url: AGENT_URL, secret: "agent-secret-xyz" });
await flow.handleMt5Cloud(deps, CHAT);
assert.match(lastText(), /installed and waiting for an account/);
assert.match(buttons(), /mt5c:connect/);
assert.doesNotMatch(buttons(), /mt5c:agent/);
console.log("   ✓\n");

console.log("[3] Connect: login, password (deleted at once), server -> the container logs in with the EA on the bot's URL\n");
upsertGroup(USER, { id: "syn", name: "Synthetic", symbols: ["VOL_80", "BOOM_100"] });
setActiveGroup(USER, "syn");
await flow.handleMt5Callback(deps, CHAT, "mt5c:connect");
await flow.tryHandleMt5Entry(deps, CHAT, "12ab", 20);
assert.match(lastText(), /digits only/);
await flow.tryHandleMt5Entry(deps, CHAT, "40123456", 21);
assert.match(lastText(), /password/);
await flow.tryHandleMt5Entry(deps, CHAT, "hunter2-secret!", 22);
assert.deepEqual(deleted, [22], "the password message is deleted the moment it's read");
assert.ok(sent.every((m) => !m.text.includes("hunter2-secret!")), "the password is never echoed");
await flow.tryHandleMt5Entry(deps, CHAT, "Deriv-Demo", 23);
assert.match(lastText(), /MetaQuotes ID/, "then the optional MetaQuotes ID");
assert.match(buttons(), /mt5c:mq:skip/);
assert.ok(!seen.some((s) => s.path === "/configure"), "nothing sent to MT5 until the last answer");
await flow.tryHandleMt5Entry(deps, CHAT, "not an id", 24);
assert.match(lastText(), /isn't a MetaQuotes ID/);
await flow.tryHandleMt5Entry(deps, CHAT, "1a2b3c4d", 25);
const conf = seen.find((s) => s.path === "/configure")!;
assert.equal(conf.secret, "agent-secret-xyz");
assert.equal(conf.body.login, "40123456");
assert.equal(conf.body.password, "hunter2-secret!", "the password goes to the container");
assert.equal(conf.body.server, "Deriv-Demo");
assert.equal(conf.body.symbol, "VOL_80", "the chart defaults to the market Dave actually trades");
const hook = getOrCreateEaWebhook(USER);
assert.equal(conf.body.webhookUrl, `http://dave-bot.railway.internal:8080${hook.path}`, "EA reports to the bot over the private network");
assert.equal(conf.body.token, hook.token);
assert.deepEqual(conf.body.metaquotesIds, ["1A2B3C4D"], "the MetaQuotes ID goes to MT5 with the login");
assert.deepEqual(conf.body.marketWatch, ["VOL_80", "BOOM_100"], "Market Watch starts as the pairs Dave trades");
assert.match(lastText(), /running and logged in \(40123456 on Deriv-Demo/);
assert.match(lastText(), /Market Watch: VOL_80, BOOM_100/);
assert.match(lastText(), /MT5 phone alerts: on \(MetaQuotes ID 1A2B3C4D\)/);
console.log("   ✓\n");

console.log("[4] Settings from Telegram: timeframe and symbol restart the EA on the same login\n");
await flow.handleMt5Callback(deps, CHAT, "mt5c:period:M15");
assert.equal(seen.filter((s) => s.path === "/settings").pop()!.body.period, "M15");
await flow.handleMt5Callback(deps, CHAT, "mt5c:symbol");
await flow.tryHandleMt5Entry(deps, CHAT, "BOOM_100", 30);
assert.equal(seen.filter((s) => s.path === "/settings").pop()!.body.symbol, "BOOM_100");
await flow.handleMt5Callback(deps, CHAT, "mt5c:push");
await flow.tryHandleMt5Entry(deps, CHAT, "500", 31);
assert.match(lastText(), /2 to 120/);
await flow.tryHandleMt5Entry(deps, CHAT, "8", 32);
assert.deepEqual(seen.filter((s) => s.path === "/settings").pop()!.body.inputs, { PushSeconds: 8 });
console.log("   ✓\n");

console.log("[4b] Market Watch: MT5 itself gets the pairs -- typed, or the pair group in one tap\n");
assert.match(buttons(), /mt5c:mw/);
await flow.handleMt5Callback(deps, CHAT, "mt5c:mw");
assert.match(lastText(), /Now: VOL_80, BOOM_100/);
assert.match(buttons(), /mt5c:mw:group/);
await flow.tryHandleMt5Entry(deps, CHAT, "VOL_80, bad symbol!", 33);
assert.match(lastText(), /doesn't look like a symbol/);
await flow.tryHandleMt5Entry(deps, CHAT, "VOL_80, eurusd  BOOM_100,VOL_80", 34);
assert.deepEqual(seen.filter((s) => s.path === "/settings").pop()!.body.marketWatch, ["VOL_80", "EURUSD", "BOOM_100"], "commas/spaces, dupes dropped");
await flow.handleMt5Callback(deps, CHAT, "mt5c:mw:group");
assert.deepEqual(seen.filter((s) => s.path === "/settings").pop()!.body.marketWatch, ["VOL_80", "BOOM_100"]);
const { parseMarketWatch } = await import("@dave/ea-bridge");
assert.throws(() => parseMarketWatch(Array.from({ length: 31 }, (_, i) => `P${i}`)), /Up to 30/);
console.log("   ✓\n");

console.log("[4c] MetaQuotes ID from /mt5: change it, or turn MT5's phone alerts off\n");
assert.match(JSON.stringify(sent.map((m) => m.reply_markup ?? {})), /mt5c:mq"/);
await flow.handleMt5Callback(deps, CHAT, "mt5c:mq");
assert.match(lastText(), /Now: 1A2B3C4D/);
await flow.tryHandleMt5Entry(deps, CHAT, "9Z8Y7X6W, 1A2B3C4D", 35);
assert.deepEqual(seen.filter((s) => s.path === "/settings").pop()!.body.metaquotesIds, ["9Z8Y7X6W", "1A2B3C4D"]);
await flow.handleMt5Callback(deps, CHAT, "mt5c:mq");
await flow.tryHandleMt5Entry(deps, CHAT, "off", 36);
assert.deepEqual(seen.filter((s) => s.path === "/settings").pop()!.body.metaquotesIds, []);
const { parseMetaquotesIds } = await import("@dave/ea-bridge");
assert.throws(() => parseMetaquotesIds("AAAAAAAA BBBBBBBB CCCCCCCC DDDDDDDD EEEEEEEE"), /up to 4/);
console.log("   ✓\n");

console.log("[5] A command cancels a half-finished flow; an unrelated message is not swallowed\n");
await flow.handleMt5Callback(deps, CHAT, "mt5c:connect");
assert.equal(await flow.tryHandleMt5Entry(deps, CHAT, "/help", 40), false);
assert.equal(await flow.tryHandleMt5Entry(deps, CHAT, "what's VOL_80 doing?", 41), false, "no flow pending -> the message goes to Dave");
console.log("   ✓\n");

console.log("[6] Dave's tools: status, and settings limited to safe EA inputs -- no password tool\n");
const names = MT5_CLOUD_TOOLS.map((t) => t.name);
assert.deepEqual(names, ["mt5_cloud_status", "mt5_cloud_settings", "mt5_cloud_restart"]);
assert.ok(!JSON.stringify(MT5_CLOUD_TOOLS.map((t) => t.parameters)).includes("password"), "no tool takes a password");
const st: any = await MT5_CLOUD_TOOLS[0].execute({}, { userId: USER });
assert.match(st.summary, /logged in/);
await assert.rejects(MT5_CLOUD_TOOLS[1].execute({ inputs: { WebhookURL: "http://evil" } }, { userId: USER }), /Not editable: WebhookURL/);
console.log("   ✓\n");

console.log("[7] A wrong secret is explained, not a raw error\n");
process.env.MT5_AGENT_URL = AGENT_URL;
process.env.MT5_AGENT_SECRET = "wrong-secret-123";
await flow.handleMt5Cloud(deps, CHAT);
assert.match(lastText(), /refused the secret/);
console.log("   ✓\n");

agent.close();
console.log("=== ALL ASSERTIONS PASSED ===");
process.exit(0);
