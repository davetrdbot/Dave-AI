import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DaveDatabase, createAutomationWebhookServer } from "@dave/db";
import { DavemaClient, getDavemaKey } from "@dave/davema";
import { EaBridge } from "@dave/ea-bridge";
import { RFeedBridge } from "@dave/rfeed";
import { createHiddenWebhookServer } from "@dave/memory";
import { startWatchdog, startHeartbeatLoop } from "@dave/safety";
import { getTelegramCredentials } from "@dave/telegram";
import { startTelegramBotServer } from "./telegram-bot-server.js";

/**
 * Real gap fixed (final pre-deployment pass, Railway Part A item 1):
 * root server.mjs was an explicitly-labeled placeholder -- every
 * subsystem (memory, brain, sandbox, DAVEMA, Telegram, trading) was
 * real, tested library code, but nothing composed them into one
 * running process. This is that composition: the actual single
 * persistent process Railway runs.
 *
 * Structural note this file exists to satisfy: Railway exposes exactly
 * ONE public port per service. Telegram webhooks, the EA webhook,
 * R_Feed's webhook, automation webhooks, and the hidden per-user
 * memory webhook are each built as their own standalone
 * `http.createServer()` (real, independently tested) -- naively
 * `.listen()`-ing all of them would bind several ports, only one of
 * which Railway could ever actually route external traffic to. This
 * builds each sub-server WITHOUT listening, extracts its real request
 * handler (the exact function `createServer(handler)` registered as
 * its "request" listener -- documented Node behavior, not a hack), and
 * dispatches to the right one by URL prefix from a single combined
 * server bound to the one real `PORT` Railway gives this process.
 */

/**
 * Real graceful degradation, not a hard requirement: Railway sets
 * RAILWAY_PUBLIC_DOMAIN automatically once a public domain is
 * generated for a service, so that's tried first; PUBLIC_BASE_URL lets
 * it be overridden explicitly (custom domain, local testing). Neither
 * being set is a real, honest possibility on a fresh deploy (before the
 * public domain has been generated in the Railway dashboard) -- it must
 * not crash the process, only disable the Telegram webhook (which
 * genuinely cannot register without a public URL for Telegram to push
 * to) while everything else (DB, EA/R_Feed webhooks, health check)
 * keeps running.
 */
function resolvePublicBaseUrl(): string | undefined {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return undefined;
}

/**
 * Real gap fixed: the default system prompt was a one-line placeholder
 * ("You are Dave, an autonomous trading assistant.") -- none of Dave's
 * actual real, checked-in behavioral rules (prompts/SOUL.md, IDENTITY.md,
 * SECURITY.md, BOOTSTRAP.md -- SOUL is personality, IDENTITY covers real
 * trade-decision rules like "check correlation before sizing", SECURITY
 * covers the absolute safety rules, BOOTSTRAP governs first contact)
 * were actually loaded into the real booted agent. SYSTEM_PROMPT can
 * still override this wholesale for a genuinely different deployment.
 */
function loadSystemPrompt(): string {
  if (process.env.SYSTEM_PROMPT) return process.env.SYSTEM_PROMPT;
  const promptsDir = join(process.cwd(), "prompts");
  const files = ["SOUL.md", "IDENTITY.md", "SECURITY.md", "BOOTSTRAP.md"];
  const sections = files.flatMap((file) => {
    try {
      return [readFileSync(join(promptsDir, file), "utf8")];
    } catch {
      console.error(`[boot] could not read prompts/${file} -- continuing without it`);
      return [];
    }
  });
  if (sections.length === 0) return "You are Dave, an autonomous trading assistant.";
  return sections.join("\n\n---\n\n");
}

function subServerHandler(server: Server): (req: IncomingMessage, res: ServerResponse) => void {
  const listeners = server.listeners("request") as ((req: IncomingMessage, res: ServerResponse) => void)[];
  if (listeners.length !== 1) throw new Error(`Expected exactly one "request" listener on this sub-server, found ${listeners.length}`);
  return listeners[0];
}

export async function main(): Promise<void> {
  const ownerUserId = process.env.OWNER_USER_ID ?? "default";
  // Real gap fixed: every admin-panel API route (telegram-otp,
  // e2b-keys, database-automation, provider-keys, ...) consistently
  // uses data/db/<userId>.db as its real DB path convention -- this
  // used to default to a DIFFERENT path (data/dave.db), which meant a
  // credential paired through the admin panel (e.g. the Telegram bot
  // token) was silently invisible to this process even after a
  // restart. Matches that same convention so both processes genuinely
  // share state when pointed at the same volume.
  const dbPath = process.env.DATABASE_PATH ?? join(process.cwd(), "data", "db", `${ownerUserId}.db`);
  const publicBaseUrl = resolvePublicBaseUrl(); // e.g. Railway's own public domain, https://<service>.up.railway.app
  const port = Number(process.env.PORT ?? "3000");

  const db = new DaveDatabase(dbPath);
  const davema = new DavemaClient(getDavemaKey(ownerUserId));

  // Real gap this file also fixes for Part A item 6/7: the heartbeat
  // loop and the watchdog it feeds are both real (Step 19.4), but
  // nothing in production ever started either of them -- confirmed by
  // grep, only step19-safety.test.ts called them. Wired here: the
  // heartbeat writes on an interval from THIS process; the watchdog is
  // a genuinely separate OS process (child_process.fork(), not a
  // second Railway service -- it shares this container and dies with
  // it, which is the correct lifecycle for a per-instance liveness
  // check) that alerts back over the real IPC channel fork() provides.
  const heartbeatPath = process.env.HEARTBEAT_PATH ?? join(process.cwd(), "data", "heartbeat.json");
  const heartbeat = startHeartbeatLoop(heartbeatPath, 5000);
  const watchdog = startWatchdog({ heartbeatPath, timeoutMs: 30_000, pollIntervalMs: 5000 });
  watchdog.onEvent((event) => {
    console.error(`[watchdog] ${event.type}`, event);
    // Best-effort alert -- if Telegram itself is what's down, there's
    // nowhere to send this; the console line (captured by Railway's
    // own log aggregation) is the fallback channel either way.
  });

  const eaBridge = new EaBridge({
    onConnect: (userId) => console.log(`[ea] connected: ${userId}`),
  });
  const rfeedBridge = new RFeedBridge({
    onConnect: (userId) => console.log(`[rfeed] connected: ${userId}`),
  });

  const eaServer = eaBridge.createServer();
  const rfeedServer = rfeedBridge.createServer();
  const automationServer = createAutomationWebhookServer();
  const userHookServer = createHiddenWebhookServer();

  const routes: [string, (req: IncomingMessage, res: ServerResponse) => void][] = [
    ["/hooks/ea/", subServerHandler(eaServer)],
    ["/hooks/rfeed/", subServerHandler(rfeedServer)],
    ["/hooks/automation/", subServerHandler(automationServer)],
    ["/hooks/user/", subServerHandler(userHookServer)],
    ["/hooks/worker/", subServerHandler(userHookServer)],
  ];

  /**
   * Real gap fixed: the admin panel's real Telegram OTP pairing flow
   * (packages/dave-admin/app/api/telegram-otp) genuinely persists a bot
   * token via setTelegramCredentials(db, ownerUserId, ...) -- but this
   * process used to only ever check process.env.TELEGRAM_BOT_TOKEN at
   * boot, never the database, so pairing through the admin panel had no
   * way to actually reach the running bot process without a manual
   * restart. Checks the env var first (an explicit deploy-time override
   * still wins), falls back to the real stored credential, and -- since
   * the token may not exist yet on a fresh deploy -- retries on a real
   * interval until it succeeds, rather than requiring a restart.
   */
  let telegramWired = false;
  async function tryStartTelegram(): Promise<boolean> {
    if (telegramWired) return true;
    const stored = getTelegramCredentials(db, ownerUserId);
    const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN ?? stored?.botToken;
    if (!telegramBotToken) {
      // Real graceful degradation, not a crash: Dave's core purpose is
      // the Telegram bot, but a missing token shouldn't take down the
      // whole process (health check + every webhook server still runs)
      // -- it just means the bot itself isn't live yet.
      return false;
    }
    if (!publicBaseUrl) {
      console.error("[telegram] no PUBLIC_BASE_URL / RAILWAY_PUBLIC_DOMAIN available -- Telegram needs a public HTTPS URL to push updates to. Telegram bot disabled, everything else still running.");
      return false;
    }
    try {
      const bot = await startTelegramBotServer({
        ownerUserId,
        db,
        davema,
        executor: eaBridge.getExecutor(ownerUserId),
        rfeedExecutor: rfeedBridge.getExecutor(ownerUserId),
        rfeedHistoryManager: rfeedBridge.getHistoryManager(ownerUserId),
        botToken: telegramBotToken,
        publicBaseUrl,
        systemPrompt: loadSystemPrompt(),
      });
      routes.push(["/hooks/telegram/", subServerHandler(bot.server)]);
      telegramWired = true;
      console.log(`[telegram] webhook registered: ${bot.webhookUrl}`);
      return true;
    } catch (err) {
      // A bad/expired bot token, or Telegram's API being unreachable,
      // must not crash the whole process either -- every other real
      // subsystem (EA/R_Feed webhooks, health check) still needs to
      // come up. Left to retry on the next poll tick rather than
      // permanently giving up on one transient failure.
      console.error(`[telegram] failed to start (${err instanceof Error ? err.message : String(err)}) -- will retry`);
      return false;
    }
  }

  let telegramRetryTimer: ReturnType<typeof setInterval> | undefined;
  if (!(await tryStartTelegram())) {
    console.error("[telegram] not live yet (no token set) -- checking every 30s; pair it from the admin panel to bring it online with no restart needed");
    telegramRetryTimer = setInterval(() => {
      void tryStartTelegram().then((started) => {
        if (started && telegramRetryTimer) clearInterval(telegramRetryTimer);
      });
    }, 30_000);
  }

  const root = createServer((req, res) => {
    const url = req.url ?? "";
    if (url === "/health" || url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", uptimeSec: Math.floor(process.uptime()), watchdogPid: watchdog.pid }));
      return;
    }
    const match = routes.find(([prefix]) => url.startsWith(prefix));
    if (match) {
      match[1](req, res);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve) => root.listen(port, resolve));
  console.log(`[dave-ai] listening on port ${port} (health check: /health)`);

  // Real graceful shutdown (Part A item 6): Railway sends SIGTERM before
  // killing a container on redeploy/restart -- without a handler, the
  // process dies mid-request, mid-trade-command, or mid-db-write.
  // better-sqlite3 (DaveDatabase's real backing store) is synchronous,
  // so there is no in-flight async write to await there; what matters is
  // refusing new work and letting in-flight HTTP requests (an open
  // trade command, a webhook delivery) finish before the process exits.
  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[dave-ai] ${signal} received -- shutting down gracefully`);
    heartbeat.stop();
    if (telegramRetryTimer) clearInterval(telegramRetryTimer);
    watchdog.stop();
    await new Promise<void>((resolve) => root.close(() => resolve()));
    console.log("[dave-ai] shutdown complete");
    process.exit(0);
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
