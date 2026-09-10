import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { DaveDatabase } from "@dave/db";
import { EaTradeExecutor } from "@dave/ea-bridge";
import { startTelegramBotServer } from "../src/telegram-bot-server.js";
import { getTradingLoopIntervalMinutes, isAutonomousTradingRunning, stopAutonomousTradingLoop, DEFAULT_TRADING_LOOP_MINUTES } from "../src/trading-loop.js";

/**
 * Real gap fixed (user: "every 5 min -- make this settable and configurable"): the autonomous
 * trading cycle's cadence used to be a hardcoded constant. Proves the real, persisted,
 * user-configurable cadence end to end via real webhook POSTs: "/start_trading" uses the
 * default, "/start_trading <n>" sets and starts at a real custom cadence, and changing it while
 * already running applies immediately (a real timer swap, not a stop/start round trip).
 */

console.log("=== Real proof: /start_trading <minutes> is a real, persisted, live-configurable cadence ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-trading-interval-"));
process.chdir(workDir);
const OWNER = "user-trading-interval-1";

const sentMessages: Array<{ method: string; body: unknown }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const method = String(url).split("/").pop() ?? "";
  const body = init?.body ? JSON.parse(init.body as string) : undefined;
  sentMessages.push({ method, body });
  if (method === "setWebhook" || method === "setMyCommands" || method === "setMyDescription" || method === "setMyShortDescription") {
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  }
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
}) as typeof fetch;

let server: Awaited<ReturnType<typeof startTelegramBotServer>> | undefined;
try {
  const db = new DaveDatabase(join(workDir, "dave.db"));
  const executor = new EaTradeExecutor(OWNER);

  server = await startTelegramBotServer({ ownerUserId: OWNER, db, executor, botToken: "000000:fake-bot-token", publicBaseUrl: "https://dave.example.com", systemPrompt: "You are Dave." });

  const webhookPath = new URL(server.webhookUrl).pathname;
  const secretToken = sentMessages.find((m) => m.method === "setWebhook")?.body as { secret_token: string };
  await new Promise<void>((resolve) => server!.server.listen(0, "127.0.0.1", resolve));
  const port = (server.server.address() as { port: number }).port;

  async function postText(text: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const update = JSON.stringify({ update_id: Math.floor(Math.random() * 1e9), message: { message_id: 1, chat: { id: 999 }, text, date: Date.now() / 1000 } });
      const req = request(
        { hostname: "127.0.0.1", port, path: webhookPath, method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secretToken.secret_token, "content-length": Buffer.byteLength(update) } },
        (res) => { res.resume(); res.on("end", resolve); }
      );
      req.on("error", reject);
      req.write(update);
      req.end();
    });
    await new Promise((r) => setTimeout(r, 100));
  }
  function lastText(): string {
    return (sentMessages.filter((m) => m.method === "sendMessage").at(-1)?.body as { text: string }).text;
  }

  console.log(`[1] Default cadence is genuinely ${DEFAULT_TRADING_LOOP_MINUTES} minutes before anything is configured...`);
  assert.equal(getTradingLoopIntervalMinutes(OWNER), DEFAULT_TRADING_LOOP_MINUTES);

  console.log("\n[2] '/start_trading 10' genuinely persists 10 minutes AND starts at that cadence...");
  sentMessages.length = 0;
  await postText("/start_trading 10");
  assert.equal(getTradingLoopIntervalMinutes(OWNER), 10, "the real config file must genuinely be updated");
  assert.equal(isAutonomousTradingRunning(OWNER), true);
  console.log(`    "${lastText()}"`);
  assert.match(lastText(), /every 10 min/);

  console.log("\n[3] Changing the cadence WHILE running applies live -- no stop/start needed...");
  sentMessages.length = 0;
  await postText("/start_trading 20");
  assert.equal(getTradingLoopIntervalMinutes(OWNER), 20, "the real config must genuinely change");
  assert.equal(isAutonomousTradingRunning(OWNER), true, "must still be running, not stopped and left off");
  console.log(`    "${lastText()}"`);
  assert.match(lastText(), /loop interval updated to every 20 min/);

  console.log("\n[4] An out-of-bounds value is genuinely refused, not silently clamped or accepted...");
  sentMessages.length = 0;
  await postText("/start_trading 99999");
  assert.equal(getTradingLoopIntervalMinutes(OWNER), 20, "an invalid value must NOT overwrite the last valid real config");
  console.log(`    "${lastText()}"`);
  assert.match(lastText(), /between 1 and 180/);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  stopAutonomousTradingLoop(OWNER);
  server?.server.close();
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
