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
 * Real gap fixed, then real behavior change (user, in live distress: "the agent should be
 * analyzing every 1 min compulsory it must place trade" -- a hard requirement, not "make it
 * configurable"). The autonomous cadence is now FIXED at 1 minute for every user -- a typed
 * "/start_trading <n>" for any n != 1 is honestly refused (the real 1-1 bounds), never silently
 * accepted at a slower cadence. Proves this end to end via real webhook POSTs.
 */

console.log("=== Real proof: the autonomous trading cadence is genuinely fixed at 1 minute, not user-configurable ===\n");

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

  console.log(`[1] Default cadence is genuinely ${DEFAULT_TRADING_LOOP_MINUTES} minute(s) -- compulsory, before anything is configured...`);
  assert.equal(getTradingLoopIntervalMinutes(OWNER), DEFAULT_TRADING_LOOP_MINUTES);
  assert.equal(DEFAULT_TRADING_LOOP_MINUTES, 1, "the compulsory cadence must genuinely be 1 minute");

  console.log("\n[2] Plain '/start_trading' genuinely starts at the compulsory 1-minute cadence...");
  sentMessages.length = 0;
  await postText("/start_trading");
  assert.equal(getTradingLoopIntervalMinutes(OWNER), 1);
  assert.equal(isAutonomousTradingRunning(OWNER), true);
  console.log(`    "${lastText()}"`);
  assert.match(lastText(), /every 1 min/);

  console.log("\n[3] '/start_trading 10' is genuinely REFUSED -- the cadence is no longer user-configurable...");
  sentMessages.length = 0;
  await postText("/start_trading 10");
  assert.equal(getTradingLoopIntervalMinutes(OWNER), 1, "the real compulsory cadence must never be overwritten");
  assert.equal(isAutonomousTradingRunning(OWNER), true, "must still be running at the compulsory cadence, not stopped");
  console.log(`    "${lastText()}"`);
  assert.match(lastText(), /between 1 and 1/);

  console.log("\n[4] An out-of-bounds value is likewise genuinely refused...");
  sentMessages.length = 0;
  await postText("/start_trading 99999");
  assert.equal(getTradingLoopIntervalMinutes(OWNER), 1, "an invalid value must NOT overwrite the real compulsory cadence");
  console.log(`    "${lastText()}"`);
  assert.match(lastText(), /between 1 and 1/);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  stopAutonomousTradingLoop(OWNER);
  server?.server.close();
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
