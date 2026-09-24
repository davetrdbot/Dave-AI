import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { DaveDatabase, createAutomationWebhookServer } from "@dave/db";
import { EaBridge, DynamicTradeExecutor, setEaPushInterval } from "@dave/ea-bridge";
import { createHiddenWebhookServer } from "@dave/memory";
import { startWatchdog, startHeartbeatLoop } from "@dave/safety";
import { getTelegramCredentials, writeTelegramStatus, type TelegramClient } from "@dave/telegram";
import { startTelegramBotServer } from "./telegram-bot-server.js";
import { getPrimaryChatId } from "./primary-chat.js";
import { buildClosedTradeMessage, buildManualCloseMessage, buildManualModifyMessage, buildWatchdogAlertMessage } from "./trade-notifications.js";
import { eaConnectionAlert, cycleErrorAlert } from "./health-alerts.js";
import { logClosedTrade } from "@dave/feedback";
import { loadSystemPrompt } from "./system-prompt.js";

export { loadSystemPrompt };

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
/** How often a bot with no token (or a failed start) tries again. */
const TELEGRAM_RETRY_MS = 5_000;

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
    // DAVE_BOT_PORT: PORT is overridden for the admin itself, but the MT5 container must be told
    // the BOT's port to reach it over Railway's private network (dave-ea-bridge mt5-cloud.ts).
    env: { ...process.env, PORT: String(ADMIN_INTERNAL_PORT), DAVE_BOT_PORT: process.env.PORT ?? "", DATA_DIR: dataDir, DAVE_DATA_ROOT: process.env.DAVE_DATA_ROOT ?? process.cwd() },
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

/**
 * Real bug fixed (user: "it doesn't trade... check anything limiting it"). DAVE_DATA_ROOT was
 * never actually set as a real Railway environment variable -- confirmed by querying the live
 * service's variables directly. Every per-user file-based store that falls back to
 * `DAVE_DATA_ROOT ?? process.cwd()` (pair groups, active pair symbol, confidence/auto-approve
 * settings, the autonomous-trading-enabled flag, EA push-interval preference, and dozens more)
 * was therefore silently writing to this process's own working directory -- NOT the real
 * persistent volume (RAILWAY_VOLUME_MOUNT_PATH) DATABASE_PATH/HEARTBEAT_PATH were separately,
 * explicitly pointed at. Every real redeploy (this repo has shipped many today) wiped every one
 * of those settings back to defaults, silently -- a real, live "why do I have to keep reminding
 * you" bug, distinct from anything in the agent's own decision logic. Exported as a pure function
 * (rather than inlined in main()) so this exact resolution logic is genuinely testable.
 */
export function resolveDataRoot(env: NodeJS.ProcessEnv, cwd: string): string {
  return env.DAVE_DATA_ROOT ?? env.RAILWAY_VOLUME_MOUNT_PATH ?? cwd;
}

/**
 * DAVE_CREDENTIALS_KEY encrypts every saved API key and token. When the deployment doesn't set one
 * (a one-click Railway template can't generate a fresh secret per deploy), the bot makes its own
 * the first time and keeps it on the volume, so it survives redeploys. An explicit env var always
 * wins. Returns where the key came from.
 */
export function ensureCredentialsKey(env: NodeJS.ProcessEnv, dataRoot: string): "env" | "file" | "created" {
  if (env.DAVE_CREDENTIALS_KEY?.trim()) return "env";
  const file = join(dataRoot, ".dave-credentials-key");
  if (existsSync(file)) {
    const saved = readFileSync(file, "utf8").trim();
    if (saved) {
      env.DAVE_CREDENTIALS_KEY = saved;
      return "file";
    }
  }
  mkdirSync(dataRoot, { recursive: true });
  const key = randomBytes(32).toString("hex");
  writeFileSync(file, key + "\n", { mode: 0o600 });
  env.DAVE_CREDENTIALS_KEY = key;
  return "created";
}

/**
 * The web panel is public, so it must never run without a password. When the deployment doesn't
 * set ADMIN_PASSWORD (the one-file Railway deploy can't keep a generated one), the bot makes one the
 * first time, keeps it on the volume, and prints the login in the service's logs -- which only the
 * people on the Railway project can see. ADMIN_USERNAME defaults to "admin". Explicit env wins.
 */
export function ensureAdminLogin(env: NodeJS.ProcessEnv, dataRoot: string): "env" | "file" | "created" {
  if (!env.ADMIN_USERNAME?.trim()) env.ADMIN_USERNAME = "admin";
  if (env.ADMIN_PASSWORD?.trim()) return "env";
  const file = join(dataRoot, ".dave-admin-password");
  if (existsSync(file)) {
    const saved = readFileSync(file, "utf8").trim();
    if (saved) {
      env.ADMIN_PASSWORD = saved;
      return "file";
    }
  }
  mkdirSync(dataRoot, { recursive: true });
  const password = randomBytes(12).toString("base64url");
  writeFileSync(file, password + "\n", { mode: 0o600 });
  env.ADMIN_PASSWORD = password;
  return "created";
}

/** Kept in sync by hand with ea/DaveEA.mq5's own compiled `PushSeconds` input -- see the boot-time
 *  re-assert below for why the source value alone was never enough to actually take effect. */
const DESIRED_EA_PUSH_SECONDS = 8;

export async function main(): Promise<void> {
  // Resolved once, here, before any store is ever read, so it's never dependent on a manually-
  // configured env var again -- falls all the way back to process.cwd() (the pre-fix behavior)
  // only when Railway's own volume-mount env var genuinely isn't present either (e.g. local dev).
  process.env.DAVE_DATA_ROOT = resolveDataRoot(process.env, process.cwd());
  if (ensureCredentialsKey(process.env, process.env.DAVE_DATA_ROOT) === "created") {
    console.log("[dave] no DAVE_CREDENTIALS_KEY set -- created one and saved it on the volume");
  }
  if (ensureAdminLogin(process.env, process.env.DAVE_DATA_ROOT) !== "env") {
    const where = resolvePublicBaseUrl() ?? "the web panel";
    console.log(`[dave] web panel login (made by the bot -- set ADMIN_PASSWORD to choose your own): ${where}  user: ${process.env.ADMIN_USERNAME}  password: ${process.env.ADMIN_PASSWORD}`);
  }
  const ownerUserId = process.env.OWNER_USER_ID ?? "default";
  // Real gap fixed: every admin-panel API route (telegram-otp,
  // e2b-keys, database-automation, provider-keys, ...) consistently
  // uses data/db/<userId>.db as its real DB path convention -- this
  // used to default to a DIFFERENT path (data/dave.db), which meant a
  // credential paired through the admin panel (e.g. the Telegram bot
  // token) was silently invisible to this process even after a
  // restart. Matches that same convention so both processes genuinely
  // share state when pointed at the same volume.
  const dbPath = process.env.DATABASE_PATH ?? join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "db", `${ownerUserId}.db`);
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
  const heartbeatPath = process.env.HEARTBEAT_PATH ?? join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "heartbeat.json");
  const heartbeat = startHeartbeatLoop(heartbeatPath, 5000);
  const watchdog = startWatchdog({ heartbeatPath, timeoutMs: 30_000, pollIntervalMs: 5000 });

  // Declared before the watchdog handler below (and before the EaBridge handlers further down)
  // because every one of them reads it at FIRE time, not at construction time -- an event that
  // lands before Telegram is paired is silently skipped rather than crashing.
  let telegramClient: TelegramClient | undefined;
  const alertOwner = (text: string): void => {
    const chatId = telegramClient && getPrimaryChatId(db, ownerUserId);
    if (telegramClient && chatId) void telegramClient.sendMessage({ chat_id: chatId, text }).catch(() => undefined);
  };

  // Real bug class fixed (the trader: "still find more bugs"). Node's default behavior turns an
  // unhandled promise rejection into an uncaught exception that kills the process outright. This
  // codebase is full of deliberate fire-and-forget calls (`void someAsync()`) -- a sound pattern
  // for work that must not block a trade -- but every single one that forgets its `.catch()`
  // becomes a live crash trigger. thinking-indicator.ts documents having been bitten by exactly
  // this and defends its own call; ea-bridge.ts's trailing tick had the identical shape and was
  // not defended until now. For a bot holding real money, dying because a cosmetic Telegram
  // update or a single stop-move hiccuped is never the right trade-off: log it loudly, tell the
  // owner, keep trading. This is the net, not a licence to skip .catch() at the call site.
  process.on("unhandledRejection", (reason) => {
    console.error("[fatal-guard] unhandled promise rejection -- kept the process alive:", reason);
    alertOwner(
      `⚠️ Something failed in the background and I caught it before it could take me down.\n\n` +
        `${reason instanceof Error ? reason.message : String(reason)}`.slice(0, 500)
    );
  });

  watchdog.onEvent((event) => {
    console.error(`[watchdog] ${event.type}`, event);
    // Real gap fixed (the trader: "find bugs this bot"): this handler's own comment used to
    // describe a "best-effort alert" that was never actually written -- the watchdog genuinely
    // detected that Dave's core process had stopped responding, and then told nobody but a
    // Railway log. The console line stays as the fallback for when Telegram itself is what's
    // down; this is the alert that was always supposed to accompany it.
    alertOwner(buildWatchdogAlertMessage(event.type, event.type === "down" ? event.staleness : undefined));
  });

  // Real gap fixed (user, with real screenshots of the live bot as proof: "a hardcoded message
  // to send when a trade is closed"): dave-ea-bridge already parses real closed-position/manual-
  // close data off every real EA report -- these events just never had a live Telegram client to
  // notify. `telegramClient` (declared above, with the watchdog that also needs it) is set once
  // tryStartTelegram() (below) genuinely succeeds; the handlers read it (and the real persisted
  // primary chat) at FIRE time, not at construction time, so a trade closing before Telegram is
  // paired is silently skipped rather than crashing.
  const eaBridge = new EaBridge({
    // Real gap fixed (the trader: "find bugs this bot"): ea-webhook.ts's isNewConnection and
    // CONNECTION_GAP_MS exist specifically to detect the EA coming (back) online -- and this
    // handler threw that detection away on a console.log, so the owner was never told their MT5
    // had reconnected. Routed through the same edge-triggered alert state as the disconnect
    // notice in telegram-bot-server.ts, so the pair can never double-report one transition.
    onConnect: (userId) => {
      console.log(`[ea] connected: ${userId}`);
      const message = eaConnectionAlert(userId, true, 0);
      if (message) alertOwner(message);
    },
    // A stop that failed to move is a real change in the owner's risk, not a cosmetic glitch --
    // they must know the ticket is still sitting at its old stop. Routed through the same
    // edge-triggered dedup as every other health alert so a persistently failing ticket reminds
    // rather than floods.
    onTrailingFailed: (userId, ticket, err) => {
      const alert = cycleErrorAlert(userId, err);
      if (alert) alertOwner(`🔧 Ticket #${ticket}: I couldn't move the trailing stop -- it's still at its previous level.\n\n${alert}`);
    },
    onManualModify: (userId, modification) => {
      const chatId = telegramClient && getPrimaryChatId(db, userId);
      if (telegramClient && chatId) void telegramClient.sendMessage({ chat_id: chatId, text: buildManualModifyMessage(modification) }).catch(() => undefined);
    },
    onClosedPosition: (userId, closed) => {
      // Real gap fixed (user: "implement journal of the day that's win rate and others"): the
      // SAME real closed-position data the hardcoded Telegram message is built from is now also
      // persisted for real win-rate aggregation -- never a second, possibly-drifting source of truth.
      logClosedTrade(db, userId, closed);
      const chatId = telegramClient && getPrimaryChatId(db, userId);
      if (telegramClient && chatId) void telegramClient.sendMessage({ chat_id: chatId, text: buildClosedTradeMessage(closed) }).catch(() => undefined);
    },
    onManualClose: (userId, position) => {
      const chatId = telegramClient && getPrimaryChatId(db, userId);
      if (telegramClient && chatId) void telegramClient.sendMessage({ chat_id: chatId, text: buildManualCloseMessage(position) }).catch(() => undefined);
    },
  });

  // Real bug fixed (the trader, live, after a long and entirely avoidable confusion: the EA's
  // compiled PushSeconds default said one thing while the actually-running MT5 terminal was on a
  // completely different value). Root cause: set_push_interval is a RUNTIME override that persists
  // on a live terminal until that terminal restarts -- so editing (or reverting) the .mq5 source
  // changes nothing about what's running right now, and the two silently drift apart with no way
  // for the owner to tell. A 120s live override outlived its own source revert this way and cost
  // real minutes per analysis cycle, with some timeframe requests hitting their full 5-minute
  // timeout. Re-asserting the intended interval here, on every boot, makes the source the single
  // source of truth: the EA picks it up on its next poll, no recompile and no admin action needed.
  setEaPushInterval(ownerUserId, DESIRED_EA_PUSH_SECONDS);

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
      writeTelegramStatus({ state: "waiting-for-token", detail: "Pair a bot in the web panel's Telegram card." });
      return false;
    }
    // No public HTTPS address (a VPS without a domain, a home machine, Docker on a laptop) no longer
    // means "no bot": it polls Telegram instead of waiting for pushes. It used to log an error here
    // and stay offline forever -- after pairing had already succeeded, which is exactly the
    // "it asked my name and then nothing worked" report from a trader who forked the repo.
    if (!publicBaseUrl) console.log("[telegram] no PUBLIC_BASE_URL / RAILWAY_PUBLIC_DOMAIN -- fetching messages from Telegram instead of using a webhook");
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
        mount: (server) => routes.push(["/hooks/telegram/", subServerHandler(server)]),
      });
      telegramClient = bot.client;
      telegramWired = true;
      console.log(bot.mode === "webhook" ? `[telegram] webhook registered: ${bot.webhookUrl}` : "[telegram] online, fetching messages from Telegram (no public URL)");
      return true;
    } catch (err) {
      // A bad/expired bot token, or Telegram's API being unreachable,
      // must not crash the whole process either -- every other real
      // subsystem (EA/R_Feed webhooks, health check) still needs to
      // come up. Left to retry on the next poll tick rather than
      // permanently giving up on one transient failure.
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[telegram] failed to start (${reason}) -- will retry`);
      writeTelegramStatus({ state: "error", detail: `The bot could not start: ${reason}. Retrying every few seconds.` });
      return false;
    }
  }

  let telegramRetryTimer: ReturnType<typeof setInterval> | undefined;
  if (!(await tryStartTelegram())) {
    // Expected, not an error: a fresh deploy legitimately has no token
    // paired yet. console.log, not console.error, so this doesn't show
    // up flagged red in Railway's dashboard as if the process crashed.
    console.log(`[telegram] not live yet -- checking every ${TELEGRAM_RETRY_MS / 1000}s; pair it from the admin panel to bring it online with no restart needed`);
    // A cheap database read while no token exists, so a pairing done in the web panel brings the
    // bot online within seconds (it was 30s, long enough for the trader to message a bot that
    // wasn't listening yet and conclude it was broken). The guard stops overlapping attempts.
    let attempting = false;
    telegramRetryTimer = setInterval(() => {
      if (attempting) return;
      attempting = true;
      void tryStartTelegram()
        .then((started) => {
          if (started && telegramRetryTimer) clearInterval(telegramRetryTimer);
        })
        .finally(() => (attempting = false));
    }, TELEGRAM_RETRY_MS);
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
