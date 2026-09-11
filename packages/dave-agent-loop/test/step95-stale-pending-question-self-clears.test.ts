import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { DaveDatabase } from "@dave/db";
import { EaTradeExecutor, createEaWebhookServer, getOrCreateEaWebhook, type EaCommand } from "@dave/ea-bridge";
import { startTelegramBotServer, runAutonomousTradingCycle } from "../src/telegram-bot-server.js";
import { createAskUserTool, clearPendingQuestion } from "../src/ask-user.js";

/**
 * Real bug fixed (user, live: confirmed via the cycle-by-cycle logging added this session --
 * Railway's own logs showed "[autonomous-tick] default: skipped -- an unanswered question is
 * still pending" on EVERY single cycle for 10+ minutes straight, permanently blocking all
 * trading). getPendingQuestion (ask-user.ts) never expires -- a question the main chat asked
 * once that the user never got to (or that got orphaned some other way) gated autonomous trading
 * FOREVER, with no error, no timeout, nothing to ever clear it. Same class of bug
 * step90-stale-busy-state-self-clears.test.ts already proved fixed for busy.json. Proves a
 * genuinely stale pending question (written with an old askedAt, simulating one the user never
 * answered) no longer blocks the cycle, while a genuinely fresh one still correctly does --
 * proven against the real logTick trace the cycle actually produces.
 */

console.log("=== Real proof: a stale pending question self-clears from the autonomous gate instead of blocking forever ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-stale-pending-question-"));
process.chdir(workDir);
const OWNER = "user-stale-pending-question-1";
const CHAT_ID = 778899;

function pendingQuestionPath(userId: string): string {
  return join(workDir, "data", "agent-loop", userId, "pending-question.json");
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 })) as typeof fetch;

const realConsoleLog = console.log;
let capturedLogs: string[] = [];
console.log = (...args: unknown[]) => {
  capturedLogs.push(args.map(String).join(" "));
  realConsoleLog(...args);
};

let server: Awaited<ReturnType<typeof startTelegramBotServer>> | undefined;
let eaServer: ReturnType<typeof createEaWebhookServer> | undefined;
let eaRunning = false;
let eaLoopPromise: Promise<void> = Promise.resolve();

try {
  const db = new DaveDatabase(join(workDir, "dave.db"));
  const executor = new EaTradeExecutor(OWNER);
  const deps = { ownerUserId: OWNER, db, executor, botToken: "000000:fake-bot-token", publicBaseUrl: "https://dave.example.com", systemPrompt: "You are Dave." };
  server = await startTelegramBotServer(deps);

  // A real, continuously-responding simulated EA (same race-free pattern as step93) -- so a real
  // analysis request the second cycle triggers resolves fast instead of waiting out its real
  // 5-minute timeout.
  const webhook = getOrCreateEaWebhook(OWNER);
  eaServer = createEaWebhookServer();
  const eaPort = await new Promise<number>((resolve) => eaServer!.listen(0, "127.0.0.1", () => resolve((eaServer!.address() as { port: number }).port)));
  const postReport = (body: unknown): Promise<{ commands: EaCommand[] }> =>
    new Promise((resolve, reject) => {
      const json = JSON.stringify(body);
      const req = request(
        { hostname: "127.0.0.1", port: eaPort, path: webhook.path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(json) } },
        (res) => { let data = ""; res.on("data", (c) => (data += c)); res.on("end", () => resolve(JSON.parse(data))); }
      );
      req.on("error", reject);
      req.write(json);
      req.end();
    });

  // A real, explicit heartbeat sent and fully awaited first -- getEaConnectionStatus only
  // reports connected once a real heartbeat has actually landed.
  await postReport({ type: "heartbeat", account: "123", balance: 1000, positions: [], pendingOrders: [] });

  eaRunning = true;
  eaLoopPromise = (async () => {
    while (eaRunning) {
      const heartbeat = { type: "heartbeat", account: "123", balance: 1000, positions: [], pendingOrders: [] };
      const resp = await postReport(heartbeat).catch(() => ({ commands: [] as EaCommand[] }));
      for (const cmd of resp.commands) {
        if (cmd.action !== "analyze") continue;
        await postReport({ ...heartbeat, results: [{ commandId: cmd.id, status: "ok", data: { price: { bid: 1, ask: 1.0002 } } }] }).catch(() => undefined);
      }
      await new Promise((r) => setTimeout(r, 30));
    }
  })();

  console.log("[1] A genuinely fresh pending question still correctly blocks the cycle...\n");
  await createAskUserTool(OWNER).execute({ question: "Which account should I use?" });
  capturedLogs = [];
  await runAutonomousTradingCycle(deps, server.client, CHAT_ID);
  assert.ok(
    capturedLogs.some((l) => l.includes("skipped -- an unanswered question is still pending")),
    "a real fresh pending question must genuinely still block the cycle"
  );
  assert.ok(!capturedLogs.some((l) => l.includes("picked")), "must never reach symbol selection while a fresh question blocks it");
  console.log("    confirmed: fresh pending question genuinely blocks the cycle before it picks a symbol");

  console.log("\n[2] The SAME question, now 20 minutes old (never answered), no longer blocks -- the cycle proceeds anyway...\n");
  const stalePath = pendingQuestionPath(OWNER);
  const staleQuestion = { id: "stale1", question: "Which account should I use?", askedAt: Date.now() - 20 * 60_000 };
  writeFileSync(stalePath, JSON.stringify(staleQuestion), "utf8");
  capturedLogs = [];
  await runAutonomousTradingCycle(deps, server.client, CHAT_ID);
  assert.ok(
    capturedLogs.some((l) => l.includes("pending question is stale") && l.includes("proceeding with autonomous trading anyway")),
    "a genuinely stale (20-minute-old, never answered) pending question must be recognized as stale, not silently ignored"
  );
  assert.ok(
    capturedLogs.some((l) => l.includes("picked")),
    "past the stale gate, the cycle must genuinely proceed to picking a real symbol -- not stop here too"
  );
  console.log("    confirmed: stale pending question no longer blocks -- the cycle genuinely proceeded to pick a symbol");

  clearPendingQuestion(OWNER);
  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  eaRunning = false;
  await eaLoopPromise;
  console.log = realConsoleLog;
  globalThis.fetch = realFetch;
  if (eaServer) eaServer.close();
  if (server) server.server.close();
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
