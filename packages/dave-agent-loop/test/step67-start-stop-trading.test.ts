import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { DaveDatabase } from "@dave/db";
import { DavemaClient } from "@dave/davema";
import { EaTradeExecutor } from "@dave/ea-bridge";
import { getInterruptState } from "@dave/safety";
import { startTelegramBotServer } from "../src/telegram-bot-server.js";
import { isAutonomousTradingRunning, stopAutonomousTradingLoop } from "../src/trading-loop.js";

/**
 * Real gap fixed (user: "you forgot /start_trading and /stop_trading, and the loop for
 * start_trading"): dave-safety already had a real tradingLoop state machine, but nothing ever
 * called startTradingLoop(), and no command turned an autonomous cycle on at all. This proves
 * the real fix end to end -- real webhook POSTs containing "/start_trading"/"/stop_trading"
 * genuinely flip the interrupt state AND the real setInterval-backed loop in trading-loop.ts,
 * not just a cosmetic reply.
 */

console.log("=== Real proof: /start_trading and /stop_trading are real, wired commands ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-start-stop-trading-"));
process.chdir(workDir);
const OWNER = "user-start-stop-trading-1";

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
  const davema = new DavemaClient(undefined, "http://127.0.0.1:1");
  const executor = new EaTradeExecutor(OWNER);

  server = await startTelegramBotServer({
    ownerUserId: OWNER,
    db,
    davema,
    executor,
    botToken: "000000:fake-bot-token",
    publicBaseUrl: "https://dave.example.com",
    systemPrompt: "You are Dave.",
  });

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

  console.log("[1] Autonomous trading is genuinely NOT running before /start_trading...");
  assert.equal(isAutonomousTradingRunning(OWNER), false);
  assert.equal(getInterruptState(OWNER).tradingLoop, "idle");

  console.log("\n[2] A real webhook POST with '/start_trading' genuinely starts the real loop...");
  sentMessages.length = 0;
  await postText("/start_trading");
  assert.equal(isAutonomousTradingRunning(OWNER), true, "the real setInterval-backed loop must genuinely be registered");
  assert.equal(getInterruptState(OWNER).tradingLoop, "running", "dave-safety's own real state must reflect it too (so /status shows it honestly)");
  const startConfirmation = sentMessages.find((m) => m.method === "sendMessage" && (m.body as { text: string }).text?.includes("Autonomous trading is on"));
  assert.ok(startConfirmation, "a real confirmation must have been sent");
  console.log(`    "${(startConfirmation!.body as { text: string }).text}"`);

  console.log("\n[3] Calling /start_trading again does NOT stack a second interval...");
  sentMessages.length = 0;
  await postText("/start_trading");
  const alreadyRunning = sentMessages.find((m) => m.method === "sendMessage" && (m.body as { text: string }).text === "Autonomous trading is already running.");
  assert.ok(alreadyRunning, "a second /start_trading must be recognized as a no-op, not a second loop");

  console.log("\n[4] A real webhook POST with '/stop_trading' genuinely stops the real loop...");
  sentMessages.length = 0;
  await postText("/stop_trading");
  assert.equal(isAutonomousTradingRunning(OWNER), false, "the real interval must genuinely be cleared");
  assert.equal(getInterruptState(OWNER).tradingLoop, "idle", "distinct from a /stop or /panic halt -- this is a clean, intentional stop");
  const stopConfirmation = sentMessages.find((m) => m.method === "sendMessage" && (m.body as { text: string }).text?.includes("Autonomous trading is off"));
  assert.ok(stopConfirmation, "a real confirmation must have been sent");
  console.log(`    "${(stopConfirmation!.body as { text: string }).text}"`);

  console.log("\n[5] Calling /stop_trading again when nothing is running says so honestly...");
  sentMessages.length = 0;
  await postText("/stop_trading");
  const wasntRunning = sentMessages.find((m) => m.method === "sendMessage" && (m.body as { text: string }).text === "Autonomous trading wasn't running.");
  assert.ok(wasntRunning, "must not claim to have stopped something that wasn't running");

  console.log("\n[6] /stop (the hard kill) ALSO stops a running autonomous loop, not just the interrupt state...");
  sentMessages.length = 0;
  await postText("/start_trading");
  assert.equal(isAutonomousTradingRunning(OWNER), true);
  await postText("/stop");
  assert.equal(isAutonomousTradingRunning(OWNER), false, "/stop must genuinely tear down the real interval too, not just flag halted state");
  console.log("    real interval torn down by /stop, not just the halted flag");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  stopAutonomousTradingLoop(OWNER);
  server?.server.close();
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}

// startTelegramBotServer wires real node-cron jobs (morning brief, dreaming, weekly export,
// security check) that keep the event loop alive -- same real-cleanup pattern step41/45 uses.
process.exit(0);
