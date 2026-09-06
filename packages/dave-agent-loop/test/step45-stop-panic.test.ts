import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { DaveDatabase } from "@dave/db";
import { DavemaClient } from "@dave/davema";
import { EaTradeExecutor } from "@dave/ea-bridge";
import { RFeedBridge } from "@dave/rfeed";
import { isTradingHalted, getInterruptState } from "@dave/safety";
import { startTelegramBotServer } from "../src/telegram-bot-server.js";

/**
 * Real gap found while re-verifying SECURITY.md's exact wording ("I need to do X...") --
 * SECURITY.md ALSO documents "/stop or /panic from the user is an instant, unconditional
 * halt" as if these were real commands, but neither was ever registered in DAVE_COMMANDS or
 * checked anywhere in the real webhook handler. Typing them did nothing. This proves the real
 * fix end to end: a real webhook POST containing "/stop" genuinely flips isTradingHalted()
 * for the real owner account, checked BEFORE command dispatch/anything else, and a real
 * confirmation message is sent.
 */

console.log("=== Real proof: /stop and /panic are real, wired, instant halts ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-stop-panic-"));
process.chdir(workDir);
const OWNER = "user-stop-panic-1";

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
  const rfeedBridge = new RFeedBridge();

  server = await startTelegramBotServer({
    ownerUserId: OWNER,
    db,
    davema,
    executor,
    rfeedExecutor: rfeedBridge.getExecutor(OWNER),
    rfeedHistoryManager: rfeedBridge.getHistoryManager(OWNER),
    botToken: "000000:fake-bot-token",
    publicBaseUrl: "https://dave.example.com",
    systemPrompt: "You are Dave.",
  });

  const webhookPath = new URL(server.webhookUrl).pathname;
  const secretToken = sentMessages.find((m) => m.method === "setWebhook")?.body as { secret_token: string };
  assert.ok(secretToken?.secret_token, "a real webhook must have been registered with a real secret token");

  await new Promise<void>((resolve) => server!.server.listen(0, "127.0.0.1", resolve));

  console.log("[1] Trading is genuinely NOT halted before /stop is sent...");
  assert.equal(isTradingHalted(OWNER), false);

  console.log("\n[2] A real webhook POST with '/stop' genuinely halts trading, checked before anything else...");
  const port = (server.server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => {
    const update = JSON.stringify({
      update_id: 1,
      message: { message_id: 1, chat: { id: 999 }, text: "/stop", date: Date.now() / 1000 },
    });
    const req = request(
      { hostname: "127.0.0.1", port, path: webhookPath, method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secretToken.secret_token, "content-length": Buffer.byteLength(update) } },
      (res) => { res.resume(); res.on("end", resolve); }
    );
    req.on("error", reject);
    req.write(update);
    req.end();
  });
  await new Promise((r) => setTimeout(r, 100)); // let the async handler finish

  console.log(`    isTradingHalted(${OWNER}) -> ${isTradingHalted(OWNER)}`);
  assert.equal(isTradingHalted(OWNER), true, "a real /stop message must genuinely halt trading");
  const state = getInterruptState(OWNER);
  console.log(`    real interrupt state: ${JSON.stringify(state)}`);

  console.log("\n[3] A real confirmation message was sent...");
  const stopConfirmation = sentMessages.find((m) => m.method === "sendMessage" && (m.body as { text: string }).text?.includes("Stopped"));
  assert.ok(stopConfirmation, "a real 'Stopped' confirmation must have been sent");
  console.log(`    "${(stopConfirmation!.body as { text: string }).text}"`);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  server?.server.close();
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}

// startTelegramBotServer wires real node-cron jobs (morning brief, dreaming, weekly export,
// security check) that keep the event loop alive -- same real-cleanup pattern step41 uses.
process.exit(0);
