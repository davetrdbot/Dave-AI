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
 * Real behavior, confirmed by the trader: the autonomous cadence defaults to 5 minutes and is
 * genuinely user-configurable via "/start_trading <minutes>" down to 1 minute (or up to 60) when
 * they want a faster/slower scan. A prior session had briefly locked this to a mandatory
 * 1-minute cadence for everyone; the trader explicitly reverted that -- this test proves the
 * real, current end-to-end behavior via real webhook POSTs.
 */

console.log("=== Real proof: the autonomous trading cadence defaults to 5 min and is genuinely user-configurable ===\n");

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

  console.log(`[1] Default cadence is genuinely ${DEFAULT_TRADING_LOOP_MINUTES} minute(s) before anything is configured...`);
  assert.equal(getTradingLoopIntervalMinutes(OWNER), DEFAULT_TRADING_LOOP_MINUTES);
  assert.equal(DEFAULT_TRADING_LOOP_MINUTES, 5, "the default cadence must genuinely be 5 minutes");

  console.log("\n[2] Plain '/start_trading' genuinely starts at the real 5-minute default...");
  sentMessages.length = 0;
  await postText("/start_trading");
  assert.equal(getTradingLoopIntervalMinutes(OWNER), 5);
  assert.equal(isAutonomousTradingRunning(OWNER), true);
  console.log(`    "${lastText()}"`);
  assert.match(lastText(), /every 5 min/);

  console.log("\n[3] '/start_trading 1' genuinely lowers the cadence to the fastest user-settable value...");
  sentMessages.length = 0;
  await postText("/start_trading 1");
  assert.equal(getTradingLoopIntervalMinutes(OWNER), 1, "the user must genuinely be able to speed the cadence up to 1 minute");
  assert.equal(isAutonomousTradingRunning(OWNER), true, "must still be running, now re-armed at the new cadence");
  console.log(`    "${lastText()}"`);
  assert.match(lastText(), /every 1 min/);

  console.log("\n[4] '/start_trading 2' genuinely re-arms at 2 minutes...");
  sentMessages.length = 0;
  await postText("/start_trading 2");
  assert.equal(getTradingLoopIntervalMinutes(OWNER), 2);
  console.log(`    "${lastText()}"`);
  assert.match(lastText(), /every 2 min/);

  console.log("\n[5] An out-of-bounds value is genuinely refused, and the prior real value is left untouched...");
  sentMessages.length = 0;
  await postText("/start_trading 99999");
  assert.equal(getTradingLoopIntervalMinutes(OWNER), 2, "an invalid value must NOT overwrite the last real, valid cadence");
  console.log(`    "${lastText()}"`);
  assert.match(lastText(), /between 1 and 60/);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  stopAutonomousTradingLoop(OWNER);
  server?.server.close();
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
