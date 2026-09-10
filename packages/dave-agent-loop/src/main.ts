import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { DaveDatabase, createAutomationWebhookServer } from "@dave/db";
import { EaBridge, DynamicTradeExecutor } from "@dave/ea-bridge";
import { createHiddenWebhookServer } from "@dave/memory";
import { startWatchdog, startHeartbeatLoop } from "@dave/safety";
import { getTelegramCredentials, type TelegramClient } from "@dave/telegram";
import { startTelegramBotServer } from "./telegram-bot-server.js";
import { getPrimaryChatId } from "./primary-chat.js";
import { buildClosedTradeMessage, buildManualCloseMessage } from "./trade-notifications.js";
import { logClosedTrade } from "@dave/feedback";

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
export function loadSystemPrompt(): string {
  if (process.env.SYSTEM_PROMPT) return process.env.SYSTEM_PROMPT;
  const promptsDir = join(process.cwd(), "prompts");
  const files = ["SOUL.md", "IDENTITY.md", "SECURITY.md", "trading.md", "BOOTSTRAP.md"];
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

/**
 * Real gap fixed (Railway platform limitation discovered while wiring
 * this up): a persistent Volume can only ever be attached to ONE
 * Railway service at a time -- confirmed directly against the real API
 * ("Volume ... is already mounted to service ... Please detach it via
 * `railway volume detach` first"), so the admin panel cannot be a
 * separate Railway service and still share this bot's real SQLite
 * files (Telegram credentials, provider keys, ...). Instead, the admin
 * panel's own built Next.js server runs as a real child process INSIDE
 * this same container/service -- same volume, same filesystem, no
 * sharing problem at all -- and every request this dispatcher doesn't
 * recognize as a bot route is reverse-proxied to it. DATA_DIR (the
 * admin routes' own real override, see packages/dave-admin/server/db-path.ts)
 * is derived from the same dbPath this process itself uses, so both
 * genuinely read/write the identical files without a second env var
 * to keep in sync.
 */
const ADMIN_INTERNAL_PORT = 3980;

function spawnAdminPanel(dataDir: string): ChildProcess | undefined {
  const adminDir = join(process.cwd(), "packages", "dave-admin");
  const nextBin = join(adminDir, "node_modules", ".bin", "next");
  if (!existsSync(nextBin) || !existsSync(join(adminDir, ".next"))) {
    console.error("[admin] packages/dave-admin isn't built (missing .next) -- admin panel disabled, everything else still running");
    return undefined;
  }
  const child = spawn(nextBin, ["start", "-p", String(ADMIN_INTERNAL_PORT)], {
    cwd: adminDir,
    // Real bug fixed (user: "I gave you the goal.yaml, why it still asking me" -- audited further
    // and found the SAME bug hits every file-based store several admin routes read/write, not
    // just goal.yaml): the admin panel runs as its own real child process with its OWN
    // process.cwd() (packages/dave-admin, per this very spawn) -- any package whose store used a
    // bare `join(process.cwd(), "data", ...)` path (model-config, workers, pair-groups/risk
    // settings, the EA's last-known account snapshot, goal.yaml) genuinely wrote to/read from a
    // DIFFERENT file than the one this bot process uses. DATA_DIR already fixed this for the
    // database specifically (db-path.ts); DAVE_DATA_ROOT is the same real fix, generalized, for
    // every other real file-based store admin routes touch.
    env: { ...process.env, PORT: String(ADMIN_INTERNAL_PORT), DATA_DIR: dataDir, DAVE_DATA_ROOT: process.cwd() },
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.on("exit", (code, signal) => {
    if (!signal) console.error(`[admin] process exited unexpectedly (code ${code})`);
  });
  return child;
}

/** Reverse-proxies one request to the admin panel's real internal Next.js server. */
function proxyToAdmin(req: IncomingMessage, res: ServerResponse): void {
  const proxied = httpRequest(
    { host: "127.0.0.1", port: ADMIN_INTERNAL_PORT, path: req.url, method: req.method, headers: req.headers },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );
  proxied.on("error", (err) => {
    console.error(`[admin] proxy error: ${err.message}`);
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "admin panel unavailable" }));
  });
  req.pipe(proxied);
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

  // Real gap fixed (user, with real screenshots of the live bot as proof: "a hardcoded message
  // to send when a trade is closed"): dave-ea-bridge already parses real closed-position/manual-
  // close data off every real EA report -- these events just never had a live Telegram client to
  // notify. `telegramClient` is set once tryStartTelegram() (below) genuinely succeeds; the
  // handlers read it (and the real persisted primary chat) at FIRE time, not at construction
  // time, so a trade closing before Telegram is paired is silently skipped rather than crashing.
  let telegramClient: TelegramClient | undefined;
  const eaBridge = new EaBridge({
    onConnect: (userId) => console.log(`[ea] connected: ${userId}`),
    onClosedPosition: (userId, closed) => {
      // Real gap fixed (user: "implement journal of the day that's win rate and others"): the
      // SAME real closed-position data the hardcoded Telegram message is built from is now also
      // persisted for real win-rate aggregation -- never a second, possibly-drifting source of truth.
      logClosedTrade(db, userId, closed);
      const chatId = telegramClient && getPrimaryChatId(db, userId);
      if (telegramClient && chatId) void telegramClient.sendMessage({ chat_id: chatId, text: buildClosedTradeMessage(closed) });
    },
    onManualClose: (userId, position) => {
      const chatId = telegramClient && getPrimaryChatId(db, userId);
      if (telegramClient && chatId) void telegramClient.sendMessage({ chat_id: chatId, text: buildManualCloseMessage(position) });
    },
  });

  const adminProcess = spawnAdminPanel(dirname(dbPath));

  const eaServer = eaBridge.createServer();
  const automationServer = createAutomationWebhookServer();
  const userHookServer = createHiddenWebhookServer();

  const routes: [string, (req: IncomingMessage, res: ServerResponse) => void][] = [
    ["/hooks/ea/", subServerHandler(eaServer)],
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
        // Real gap fixed (user: "so incase they don't want to use the ea I can provide my mcp
        // for the placing of trade"): routes every real trade call through whichever backend
        // (the MT5 EA, or a real configured MCP trading server) the user has actually chosen
        // via /ea -- re-checked live on every call, no restart needed to switch.
        executor: new DynamicTradeExecutor(ownerUserId, eaBridge.getExecutor(ownerUserId)),
        botToken: telegramBotToken,
        publicBaseUrl,
        systemPrompt: loadSystemPrompt(),
      });
      routes.push(["/hooks/telegram/", subServerHandler(bot.server)]);
      telegramClient = bot.client;
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
    // Expected, not an error: a fresh deploy legitimately has no token
    // paired yet. console.log, not console.error, so this doesn't show
    // up flagged red in Railway's dashboard as if the process crashed.
    console.log("[telegram] not live yet (no token set) -- checking every 30s; pair it from the admin panel to bring it online with no restart needed");
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
    if (adminProcess) {
      proxyToAdmin(req, res);
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
    adminProcess?.kill("SIGTERM");
    await new Promise<void>((resolve) => root.close(() => resolve()));
    console.log("[dave-ai] shutdown complete");
    process.exit(0);
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
