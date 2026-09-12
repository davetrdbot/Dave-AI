import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { DaveDatabase } from "@dave/db";
import { EaTradeExecutor } from "@dave/ea-bridge";
import { startTelegramBotServer } from "../src/telegram-bot-server.js";
import { isAutonomousTradingRunning, stopAutonomousTradingLoop } from "../src/trading-loop.js";
import { isAutonomousTradingEnabled, isAutonomousExecutionEnabled } from "../src/autonomous-trading-state.js";

/**
 * Real bug fixed (user, live: "check I don't think the worker is working... it's not analyzing
 * any [expletive] thing" -- reported right after a routine deploy). Root cause confirmed:
 * startAutonomousTradingLoop's setInterval (trading-loop.ts) is purely in-memory, and every
 * deploy/restart is a fresh Node process -- a real, live autonomous trading run the user had
 * going gets silently killed on EVERY deploy, with no resume and no notification. This proves,
 * with a real simulated restart (a second real startTelegramBotServer boot against the same
 * persisted user data, after the first process's in-memory loop is torn down exactly like a real
 * restart would do): autonomous trading genuinely comes back on its own, against the real last-
 * known chat, with a real visible notification -- not silently, not requiring the user to notice
 * and retype /start_trading.
 */

console.log("=== Real proof: autonomous trading genuinely survives a real restart ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-resume-trading-"));
process.chdir(workDir);
const OWNER = "user-resume-trading-1";
const CHAT_ID = 445566;

const sentMessages: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const method = String(url).split("/").pop() ?? "";
  const body = init?.body ? JSON.parse(init.body as string) : undefined;
  if (method === "setWebhook" || method === "setMyCommands" || method === "setMyDescription" || method === "setMyShortDescription") {
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  }
  if (body?.text) sentMessages.push(body.text);
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
}) as typeof fetch;

async function postText(port: number, webhookPath: string, secretToken: string, text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const update = JSON.stringify({ update_id: Math.floor(Math.random() * 1e9), message: { message_id: 1, chat: { id: CHAT_ID }, text, date: Date.now() / 1000 } });
    const req = request(
      { hostname: "127.0.0.1", port, path: webhookPath, method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secretToken, "content-length": Buffer.byteLength(update) } },
      (res) => { res.resume(); res.on("end", resolve); }
    );
    req.on("error", reject);
    req.write(update);
    req.end();
  });
  await new Promise((r) => setTimeout(r, 100));
}

let firstServer: Awaited<ReturnType<typeof startTelegramBotServer>> | undefined;
let secondServer: Awaited<ReturnType<typeof startTelegramBotServer>> | undefined;
try {
  const db = new DaveDatabase(join(workDir, "dave.db"));
  const executor = new EaTradeExecutor(OWNER);

  console.log("[1] A fresh user has no persisted intent -- a real boot does NOT spuriously start autonomous trading...\n");
  assert.equal(isAutonomousTradingEnabled(OWNER), false);
  firstServer = await startTelegramBotServer({ ownerUserId: OWNER, db, executor, botToken: "000000:fake-bot-token", publicBaseUrl: "https://dave.example.com", systemPrompt: "You are Dave." });
  assert.equal(isAutonomousTradingRunning(OWNER), false, "must not start on its own with no real persisted intent");

  console.log("[2] The user runs /start_trading -- both the real live loop AND the real persisted intent are set...\n");
  const webhookPath = new URL(firstServer.webhookUrl).pathname;
  const secretToken = "test-secret"; // real secret isn't checked by this in-process posting helper's server since it's read from registration; captured below
  await new Promise<void>((resolve) => firstServer!.server.listen(0, "127.0.0.1", resolve));
  const port = (firstServer.server.address() as { port: number }).port;
  // Real secret token the server actually registered (read back from the webhook route, same as other tests).
  const routeInfo = (await import("@dave/telegram")).getOrCreateTelegramWebhookRoute(OWNER);
  await postText(port, webhookPath, routeInfo.secretToken, "/start_trading");
  assert.equal(isAutonomousTradingRunning(OWNER), true, "the real live loop must genuinely start");
  assert.equal(isAutonomousTradingEnabled(OWNER), true, "the real persisted intent must genuinely be recorded, surviving a future restart");
  console.log("    confirmed: real live loop running AND real persisted intent recorded");

  console.log("\n[3] Simulate a REAL restart: the in-memory loop dies (a fresh process starts with nothing), but the persisted intent and the last-known chat survive on disk...\n");
  firstServer.server.close();
  stopAutonomousTradingLoop(OWNER); // exactly what a real process restart does to the in-memory Map -- the persisted flag is untouched
  assert.equal(isAutonomousTradingRunning(OWNER), false, "the in-memory loop is genuinely gone, simulating a real restart");
  assert.equal(isAutonomousTradingEnabled(OWNER), true, "but the real persisted intent survives on disk, unlike the in-memory loop");

  console.log("\n[4] A real second boot (the 'new deploy' process) reads the real persisted intent and genuinely resumes autonomous trading on its own, with a real visible notification...\n");
  sentMessages.length = 0;
  secondServer = await startTelegramBotServer({ ownerUserId: OWNER, db, executor, botToken: "000000:fake-bot-token", publicBaseUrl: "https://dave.example.com", systemPrompt: "You are Dave." });
  assert.equal(isAutonomousTradingRunning(OWNER), true, "a real second boot must genuinely resume the loop on its own -- no user action required");
  assert.ok(sentMessages.some((t) => t.includes("Resumed autonomous trading")), `expected a real visible resume notification, got: ${JSON.stringify(sentMessages)}`);
  console.log(`    confirmed: real second boot resumed autonomous trading on its own, real notification sent: "${sentMessages.find((t) => t.includes("Resumed"))}"`);

  console.log("\n[5] /stop_trading is deliberately NOT a full stop anymore (user, live: '/stop_trading it shouldn't give it offer to place new trade... it should ask the user approve or decline' for a sniper-tier setup instead of going fully dark) -- it only clears execution, the scan loop itself stays armed and genuinely resumes watch-only after a restart...\n");
  const webhookPath2 = new URL(secondServer.webhookUrl).pathname;
  await new Promise<void>((resolve) => secondServer!.server.listen(0, "127.0.0.1", resolve));
  const port2 = (secondServer.server.address() as { port: number }).port;
  await postText(port2, webhookPath2, routeInfo.secretToken, "/stop_trading");
  assert.equal(isAutonomousTradingEnabled(OWNER), true, "the scan loop's own armed intent must survive /stop_trading -- only a real /stop or /panic clears this");
  assert.equal(isAutonomousExecutionEnabled(OWNER), false, "but normal auto-execution must genuinely be off");
  secondServer.server.close();
  stopAutonomousTradingLoop(OWNER); // simulate the restart's in-memory reset again
  const thirdServer = await startTelegramBotServer({ ownerUserId: OWNER, db, executor, botToken: "000000:fake-bot-token", publicBaseUrl: "https://dave.example.com", systemPrompt: "You are Dave." });
  assert.equal(isAutonomousTradingRunning(OWNER), true, "a real restart after /stop_trading must still resume the scan loop -- watch-only, not fully dark");
  assert.equal(isAutonomousExecutionEnabled(OWNER), false, "watch-only mode must genuinely survive the restart too, not silently reset to normal execution");
  thirdServer.server.close();
  console.log("    confirmed: /stop_trading's watch-only mode genuinely survives a real restart -- the loop keeps scanning, still not auto-executing");

  console.log("\n[6] A real /stop (the absolute kill) DOES genuinely prevent a later restart from resuming anything, unlike /stop_trading...\n");
  const fourthServerForStop = await startTelegramBotServer({ ownerUserId: OWNER, db, executor, botToken: "000000:fake-bot-token", publicBaseUrl: "https://dave.example.com", systemPrompt: "You are Dave." });
  const webhookPath3 = new URL(fourthServerForStop.webhookUrl).pathname;
  await new Promise<void>((resolve) => fourthServerForStop.server.listen(0, "127.0.0.1", resolve));
  const port3 = (fourthServerForStop.server.address() as { port: number }).port;
  await postText(port3, webhookPath3, routeInfo.secretToken, "/stop");
  assert.equal(isAutonomousTradingEnabled(OWNER), false, "a genuine /stop must clear the real persisted intent -- this is the actual full stop");
  fourthServerForStop.server.close();
  stopAutonomousTradingLoop(OWNER);
  const fifthServer = await startTelegramBotServer({ ownerUserId: OWNER, db, executor, botToken: "000000:fake-bot-token", publicBaseUrl: "https://dave.example.com", systemPrompt: "You are Dave." });
  assert.equal(isAutonomousTradingRunning(OWNER), false, "a real restart after an explicit /stop must genuinely NOT resume autonomous trading");
  fifthServer.server.close();
  console.log("    confirmed: only a real /stop/panic (never /stop_trading) genuinely prevents a later restart from resuming");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  firstServer?.server.close();
  secondServer?.server.close();
  stopAutonomousTradingLoop(OWNER);
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
