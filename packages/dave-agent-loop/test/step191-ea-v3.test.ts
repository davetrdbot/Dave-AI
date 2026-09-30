import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "dave-ea-v3-"));
process.env.DAVE_DATA_ROOT = root;

/** The trader: "the EA endpoints -- understand the code, upgrade it, fix it and give it correct data
 *  and add more endpoints". Bot side of EA 3.0. */
const bridge = await import("@dave/ea-bridge");
const { createEaWebhookServer, getOrCreateEaWebhook, getLastKnownAccountSnapshot, getEaConnectionStatus, peekQueue, CURRENT_EA_VERSION, isEaOutdated, EA_ANALYSIS_TOOLS, EA_STATE_TOOLS } = bridge;
const { coerceTickActions, gatherData, MODE2_EXTRA_ENDPOINTS } = await import("../src/tick-actions.js");
const { buildClosedTradeMessage } = await import("../src/trade-notifications.js");
const { LIVE_TOOL_NAMES } = await import("../src/live-voice.js");
const { TOOL_CATALOG_CATEGORIES } = await import("../src/tool-catalog.js");
const { ALL_ANALYSIS_ENDPOINTS } = await import("@dave/trading");

console.log("=== Step 191: EA 3.0 (correct data + new endpoints), bot side ===\n");
const userId = "ea-v3";
const hook = getOrCreateEaWebhook(userId);

const reports: { isFirstReport?: boolean; positions: number }[] = [];
const server = createEaWebhookServer({ onReport: (_u, report, previous) => reports.push({ isFirstReport: previous.isFirstReport, positions: report.positions.length }) });
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as { port: number }).port;

/** Posts a body in two raw chunks (to split a multi-byte character across them). */
function post(parts: Buffer[]): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "POST", path: hook.path, headers: { "content-type": "application/json" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    for (const p of parts) req.write(p);
    req.end();
  });
}
const heartbeat = (extra: Record<string, unknown>) => ({ type: "heartbeat", account: "40123456", balance: 1000, equity: 1010, positions: [], pendingOrders: [], ...extra });

console.log("[1] An older EA (no version) still works, and the bot says an update is available");
let r = await post([Buffer.from(JSON.stringify(heartbeat({ positions: [{ ticket: "-1294967296", symbol: "VOL_10", type: "buy", lots: 0.5, openPrice: 5000 }] })))]);
assert.equal(r.status, 200);
assert.equal(getEaConnectionStatus(userId).eaUpdateAvailable, true);
assert.equal(getEaConnectionStatus(userId).eaVersion, undefined);
assert.equal(reports.at(-1)!.isFirstReport, true, "very first report");
await post([Buffer.from(JSON.stringify(heartbeat({ positions: [{ ticket: "-1294967296", symbol: "VOL_10", type: "buy", lots: 0.5, openPrice: 5000 }] })))]);
assert.equal(reports.at(-1)!.isFirstReport, false, "same old EA again: normal report");
console.log("   ✓\n");

console.log("[2] The first report from EA 3.0 starts fresh -- the corrected ticket numbers don't read as close+open");
const v3 = heartbeat({
  eaVersion: "3.3",
  currency: "USD",
  marginLevel: 1234.5,
  profit: 10,
  serverUtcOffset: 10800,
  positions: [{ ticket: "3000000000", symbol: "VOL_10", type: "buy", lots: 0.5, openPrice: 5000, swap: -0.2, openTime: "2026-09-29T10:00:00Z", magic: 88001, byDave: true, comment: "Dave 🚀", digits: 2 }],
});
// Split the emoji's 4 UTF-8 bytes across two chunks.
const bytes = Buffer.from(JSON.stringify(v3), "utf8");
const cut = bytes.indexOf(Buffer.from("🚀", "utf8")) + 2;
r = await post([bytes.subarray(0, cut), bytes.subarray(cut)]);
assert.equal(r.status, 200);
assert.equal(reports.at(-1)!.isFirstReport, true, "version changed -> fresh start, no fake close/open events");
const state = JSON.parse(readFileSync(join(root, "data", "ea-bridge", userId, "last-known-state.json"), "utf8"));
assert.equal(state.positions[0].ticket, "3000000000", "the full ticket number");
assert.equal(state.positions[0].comment, "Dave 🚀", "a character split across network chunks arrives intact");
const snap = getLastKnownAccountSnapshot(userId)!;
assert.equal(snap.eaVersion, "3.3");
assert.equal(snap.currency, "USD");
assert.equal(snap.marginLevel, 1234.5);
assert.equal(snap.serverUtcOffset, 10800);
assert.equal(getEaConnectionStatus(userId).eaUpdateAvailable, false);
await post([Buffer.from(JSON.stringify(v3))]);
assert.equal(reports.at(-1)!.isFirstReport, false, "same version again: normal report");
assert.equal(CURRENT_EA_VERSION, "3.3");
assert.equal(isEaOutdated("2.9"), true);
assert.equal(isEaOutdated("3.0"), true);
assert.equal(isEaOutdated("3.1"), true);
assert.equal(isEaOutdated("3.2"), true);
assert.equal(isEaOutdated("3.3"), false);
assert.equal(isEaOutdated(undefined), true);
const bal = (await EA_STATE_TOOLS.find((t) => t.name === "get_account_balance")!.execute({}, { userId })) as Record<string, unknown>;
assert.equal(bal.currency, "USD");
assert.equal(bal.marginLevel, 1234.5);
assert.equal(bal.eaUpdateAvailable, false);
console.log("   ✓\n");

console.log("[2b] EA 3.2's one-second poll: hands over queued jobs at once and leaves the saved trades alone");
bridge.enqueueCommand(userId, { id: "job-1", action: "analyze", endpoint: "all", symbol: "VOL_10", timeframe: "H1" } as never);
r = await post([Buffer.from(JSON.stringify({ type: "poll", eaVersion: "3.3" }))]);
assert.equal(r.status, 200);
assert.deepEqual(JSON.parse(r.body).commands.map((c: { id: string }) => c.id), ["job-1"], "the job goes out on the poll, not on the next full report");
const kept = JSON.parse(readFileSync(join(root, "data", "ea-bridge", userId, "last-known-state.json"), "utf8"));
assert.equal(kept.positions[0]?.ticket, "3000000000", "a poll carries no positions, so the open trade is still there");
console.log("   ✓\n");

console.log("[3] A stop-out has its own words");
assert.equal(buildClosedTradeMessage({ ticket: "1", symbol: "BOOM_100", pnl: -52.1, reason: "stopout" }), "🔴 BOOM_100 closed. -$52.10. (stop-out: the broker closed it for margin)");
assert.match(buildClosedTradeMessage({ ticket: "1", symbol: "VOL_10", pnl: 0, reason: "unknown", historyMissing: true }), /MT5 hasn't said why/);
console.log("   ✓\n");

console.log("[4] New tools send their settings to the EA");
const tool = (name: string) => [...EA_ANALYSIS_TOOLS].find((t) => t.name === name)!;
const run = (name: string, args: Record<string, unknown>) => tool(name).execute(args, { userId, timeoutMs: 50 }).catch(() => undefined);
const lastCmd = () => peekQueue(userId).at(-1) as Record<string, unknown>;
await run("get_candles", { symbol: "VOL_10", timeframe: "M5", count: 900 });
assert.deepEqual({ endpoint: lastCmd().endpoint, count: lastCmd().count, timeframe: lastCmd().timeframe }, { endpoint: "candles", count: 300, timeframe: "M5" }, "count clamped to 300");
await run("get_candles", { symbol: "VOL_10" });
assert.equal(lastCmd().count, 21, "21 by default");
await run("get_position_size", { symbol: "XAUUSD", side: "sell", sl: 2665.5, risk_pct: 0.5 });
assert.deepEqual({ e: lastCmd().endpoint, side: lastCmd().side, sl: lastCmd().sl, risk: lastCmd().risk_pct, entry: lastCmd().entry }, { e: "position_size", side: "sell", sl: 2665.5, risk: 0.5, entry: undefined });
await run("get_deal_history", { days: 400 });
assert.deepEqual({ e: lastCmd().endpoint, days: lastCmd().days, symbol: lastCmd().symbol }, { e: "history", days: 90, symbol: "" });
await run("get_mtf", { symbol: "EURUSD" });
assert.equal(lastCmd().endpoint, "mtf");
await run("get_symbol_info", { symbol: "BOOM_100" });
assert.equal(lastCmd().endpoint, "symbol_info");
await run("get_adx", { symbol: "EURUSD", timeframe: "H1" });
assert.equal(lastCmd().endpoint, "adx");
// Settings can never overwrite the command's own fields.
const { requestAnalysis } = bridge;
await requestAnalysis(userId, "trend", "EURUSD", "H1", { timeoutMs: 50, params: { action: "open", endpoint: "evil", id: "x" } }).catch(() => undefined);
assert.equal(lastCmd().action, "analyze");
assert.equal(lastCmd().endpoint, "trend");
assert.notEqual(lastCmd().id, "x");
console.log("   ✓\n");

console.log("[5] Mode 2 can ask for the multi-timeframe summary -- and it is NOT in get_all_analysis");
assert.deepEqual(MODE2_EXTRA_ENDPOINTS, ["mtf", "adx", "symbol_info"]);
const acts = coerceTickActions([{ type: "GET", endpoint: "get_mtf" }, { type: "GET", endpoint: "adx", timeframe: "h4" }, { type: "GET", endpoint: "history" }, { type: "GET", endpoint: "position_size" }]);
assert.deepEqual(acts?.map((a) => (a as { endpoint: string }).endpoint), ["mtf", "adx"], "history/position_size need settings, not mode-2 reads");
assert.ok(!(ALL_ANALYSIS_ENDPOINTS as readonly string[]).includes("mtf"), "mtf is not part of the analysis suite");
const asked: string[] = [];
const g = await gatherData({ get: async (e: string, s: string) => { asked.push(`${e}:${s}`); return { timeframes: { M5: { bias: "BULL" } }, alignment: "ALL_BULL" } as never; } }, acts!, "EURUSD");
assert.deepEqual(asked, ["mtf:EURUSD", "adx:EURUSD"]);
assert.match(g.lines[0], /^MTF EURUSD/);
assert.match(g.lines[0], /ALL_BULL/);
console.log("   ✓\n");

console.log("[6] Listed for chat, the tool catalog and voice calls");
for (const n of ["get_mtf", "get_adx", "get_symbol_info", "get_position_size", "get_deal_history"]) {
  assert.ok(TOOL_CATALOG_CATEGORIES.Analysis.includes(n), `${n} in the catalog`);
  assert.ok(LIVE_TOOL_NAMES.has(n), `${n} on voice calls`);
}
const allTool = tool("get_all_analysis");
assert.doesNotMatch(allTool.description, /multi-timeframe summary/i);
console.log("   ✓\n");

server.close();
console.log("=== step191 EA v3 bot side: ALL ASSERTIONS PASSED ===");
